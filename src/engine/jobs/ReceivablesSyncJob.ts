import { IJob, JobContext, JobResult } from '../JobRegistry';
import { ILogger } from '../../observability/Logger';
import { IReceivablesProvider } from '../../contracts/providers';
import { IReceivablesRepository } from '../../contracts/repositories';
import { ReceivableMapper } from '../Mappers';

import { IClock } from '../../utils/Clock';

export class ReceivablesSyncJob implements IJob {
  private static readonly COMPONENT = 'ReceivablesSyncJob';

  constructor(
    private provider: IReceivablesProvider,
    private repo: IReceivablesRepository,
    private logger: ILogger,
    private clock: IClock
  ) {}

  async execute(context: JobContext): Promise<JobResult> {
    const { abortSignal, lastSyncState, policy } = context;
    this.logger.info(ReceivablesSyncJob.COMPONENT, 'Starting receivables sync');

    let errors = 0;
    let synced = 0;

    try {
      if (!policy.operation_config) {
        throw new Error('CONFIGURATION_ERROR: FIN-001 requires operation_config');
      }
      
      const config = policy.operation_config as Record<string, unknown>;
      
      const status = config.status;
      const pedido = config.pedido;
      const maxRangeDays = config.maxRangeDays;

      if (typeof status !== 'string' || status.trim() === '') {
        throw new Error('CONFIGURATION_ERROR: FIN-001 requires explicit status in operation_config');
      }
      if (typeof pedido !== 'string' || pedido.trim() === '') {
        throw new Error('CONFIGURATION_ERROR: FIN-001 requires explicit pedido in operation_config');
      }
      if (typeof maxRangeDays !== 'number' || maxRangeDays <= 0) {
        throw new Error('CONFIGURATION_ERROR: FIN-001 requires explicit maxRangeDays in operation_config');
      }

      if (!lastSyncState || !lastSyncState.cursor_value) {
        throw new Error('BOOTSTRAP_REQUIRED: FIN-001 requires an explicit bootstrap cursor (e.g. { "lastEndDate": "YYYY-MM-DD" })');
      }

      let parsedCursor: unknown;
      try {
        parsedCursor = JSON.parse(lastSyncState.cursor_value);
      } catch (err) {
        throw new Error('CURSOR_ERROR: FIN-001 cursor is malformed JSON');
      }

      if (!parsedCursor || typeof parsedCursor !== 'object') {
        throw new Error('CURSOR_ERROR: FIN-001 cursor is malformed. Expected { lastEndDate: "YYYY-MM-DD" }');
      }

      const cursor = parsedCursor as Record<string, unknown>;
      if (typeof cursor.lastEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cursor.lastEndDate)) {
        throw new Error('CURSOR_ERROR: FIN-001 cursor is malformed. Expected { lastEndDate: "YYYY-MM-DD" }');
      }

      const periodStart = cursor.lastEndDate;
      const startDate = new Date(periodStart);
      if (isNaN(startDate.getTime())) {
        throw new Error('CURSOR_ERROR: FIN-001 cursor lastEndDate is not a valid date');
      }

      // Add maxRangeDays to get periodEnd
      const endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + maxRangeDays);
      
      // Ensure we don't fetch beyond today (to avoid empty future queries if that's an issue)
      const now = new Date(this.clock.now());
      let actualEndDate = endDate;
      if (actualEndDate > now) {
        actualEndDate = now;
      }

      const periodEnd = actualEndDate.toISOString().split('T')[0];

      if (abortSignal.aborted) throw new Error('Aborted by scheduler');

      const rawReceivables = await this.provider.getReceivables(periodStart, periodEnd, status, pedido, abortSignal);
      const normalized = rawReceivables.map(raw => {
        try {
          return ReceivableMapper.normalize(raw);
        } catch (err) {
          errors++;
          return null;
        }
      }).filter(r => r !== null);
      
      await this.repo.upsertMany(normalized);
      synced = normalized.length;

      if (abortSignal.aborted) throw new Error('Aborted by scheduler');

      // Return the new cursor on success to advance the slice
      return {
        success: errors === 0,
        retryable: true,
        cursorValue: JSON.stringify({ lastEndDate: periodEnd }),
        metrics: {
          synced,
          errors
        }
      };

    } catch (err) {
      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }
      return { success: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
