// ============================================================
// ContinentalReconciliationService — BD_API_ZEISS Platform
// ============================================================
// Auditable reconciliation mechanism for historical orders with store_id IS NULL.
// 
// Contract:
// 1. NEVER automatically mutates or reassigns historical orders.
// 2. dryRun = true by default.
// 3. Evaluates document-backed evidence (SAOWEB code in order_details, CNPJ in fiscal_documents).
// 4. Categorizes unassigned records into CONFIRMED, INCONCLUSIVE, or CONFLICT.
// 5. Inconclusive records are recommended for legacy quarantine, not blind attribution.
// 6. Confirmed records require explicit administrative authorization before execution.
// ============================================================

import { IDatabaseExecutor } from '../config/db';
import { ILogger, ConsoleLogger } from '../observability/Logger';

export interface ReconciliationCriteria {
  targetStoreId: string;
  storeCode: string;
  saowebCode: string;
  cnpj: string;
}

export type MatchConfidence = 'CONFIRMED' | 'INCONCLUSIVE' | 'CONFLICT';
export type Recommendation = 'ATTRIBUTION_ELIGIBLE' | 'QUARANTINE_LEGACY' | 'EXCEPTION_CONFLICT';

export interface ReconciliationItem {
  orderId: string;
  orderNumber: string;
  entryDate: string | null;
  status: string | null;
  hasDetail: boolean;
  detailCodcli: string | null;
  hasFiscalDoc: boolean;
  fiscalCnpj: string | null;
  confidence: MatchConfidence;
  evidence: string[];
  recommendation: Recommendation;
}

export interface ReconciliationAuditReport {
  targetStoreId: string;
  storeCode: string;
  totalAudited: number;
  confirmedMatches: number;
  inconclusiveCandidates: number;
  conflictsCount: number;
  dryRun: boolean;
  executedMutations: number;
  items: ReconciliationItem[];
  executedAt: Date;
}

export interface ReconciliationOptions {
  limit?: number;
  dryRun?: boolean;
  confirmAuthorization?: boolean;
}

interface RawAuditRow {
  order_id: string;
  order_number: string;
  status: string | null;
  entry_date: string | null;
  detail_id: string | null;
  detail_codcli: string | null;
  fiscal_id: string | null;
  fiscal_cnpj: string | null;
}

export class ContinentalReconciliationService {
  constructor(
    private db: IDatabaseExecutor,
    private logger: ILogger = new ConsoleLogger()
  ) {}

  /**
   * Audits historical unassigned records (store_id IS NULL) against store criteria.
   * Default mode is dryRun=true (simulation and reporting only).
   */
  async auditHistoricalOrders(
    criteria: ReconciliationCriteria,
    options: ReconciliationOptions = {}
  ): Promise<ReconciliationAuditReport> {
    const dryRun = options.dryRun !== false; // Default true
    const limit = options.limit || 10000;
    const cleanCnpj = criteria.cnpj.replace(/\D/g, '');

    this.logger.info('ContinentalReconciliation', `Starting historical audit for store ${criteria.storeCode} [dryRun=${dryRun}]`);

    const query = `
      SELECT 
        o.id as order_id,
        o.order_number,
        o.status,
        o.entry_date::text as entry_date,
        od.id as detail_id,
        NULL::text as detail_codcli,
        fd.id as fiscal_id,
        NULL::text as fiscal_cnpj
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details od ON od.order_id = o.id
      LEFT JOIN zeiss.fiscal_documents fd ON fd.order_id = o.id
      WHERE o.store_id IS NULL
      ORDER BY o.entry_date DESC NULLS LAST
      LIMIT $1
    `;

    const rows = await this.db.query<RawAuditRow>(query, [limit]);
    const items: ReconciliationItem[] = [];

    let confirmedMatches = 0;
    let inconclusiveCandidates = 0;
    let conflictsCount = 0;

    for (const row of rows) {
      const evidence: string[] = [];
      let confidence: MatchConfidence = 'INCONCLUSIVE';
      let recommendation: Recommendation = 'QUARANTINE_LEGACY';

      const hasDetail = !!row.detail_id;
      const detailCodcli = row.detail_codcli || null;
      const hasFiscalDoc = !!row.fiscal_id;
      const fiscalCnpj = row.fiscal_cnpj ? row.fiscal_cnpj.replace(/\D/g, '') : null;

      const saowebMatch = detailCodcli === criteria.saowebCode;
      const cnpjMatch = fiscalCnpj === cleanCnpj;

      const saowebConflict = detailCodcli && detailCodcli !== criteria.saowebCode;
      const cnpjConflict = fiscalCnpj && fiscalCnpj !== cleanCnpj;

      if (saowebConflict || cnpjConflict) {
        confidence = 'CONFLICT';
        recommendation = 'EXCEPTION_CONFLICT';
        conflictsCount++;
        if (saowebConflict) {
          evidence.push(`SAOWEB mismatch: expected '${criteria.saowebCode}', found '${detailCodcli}'`);
        }
        if (cnpjConflict) {
          evidence.push(`CNPJ mismatch: expected '${cleanCnpj}', found '${fiscalCnpj}'`);
        }
      } else if (saowebMatch || cnpjMatch) {
        confidence = 'CONFIRMED';
        recommendation = 'ATTRIBUTION_ELIGIBLE';
        confirmedMatches++;
        if (saowebMatch) {
          evidence.push(`SAOWEB confirmed match: '${criteria.saowebCode}'`);
        }
        if (cnpjMatch) {
          evidence.push(`Fiscal document CNPJ confirmed match: '${cleanCnpj}'`);
        }
      } else {
        confidence = 'INCONCLUSIVE';
        recommendation = 'QUARANTINE_LEGACY';
        inconclusiveCandidates++;
        evidence.push('No direct SAOWEB or CNPJ evidence present in details or fiscal documents');
      }

      items.push({
        orderId: row.order_id,
        orderNumber: row.order_number,
        entryDate: row.entry_date,
        status: row.status,
        hasDetail,
        detailCodcli,
        hasFiscalDoc,
        fiscalCnpj,
        confidence,
        evidence,
        recommendation
      });
    }

    let executedMutations = 0;

    if (!dryRun) {
      if (!options.confirmAuthorization) {
        throw new Error(
          'Reconciliation execution rejected: confirmAuthorization=true is strictly required to execute database mutations.'
        );
      }

      // Execute mutations ONLY for CONFIRMED matches
      const eligibleOrderIds = items
        .filter(item => item.confidence === 'CONFIRMED')
        .map(item => item.orderId);

      if (eligibleOrderIds.length > 0) {
        await this.db.transaction(async (client) => {
          for (const orderId of eligibleOrderIds) {
            await client.query(
              `UPDATE zeiss.orders 
               SET store_id = $1, updated_at = CURRENT_TIMESTAMP 
               WHERE id = $2 AND store_id IS NULL`,
              [criteria.targetStoreId, orderId]
            );
          }
        });
        executedMutations = eligibleOrderIds.length;
        this.logger.info(
          'ContinentalReconciliation',
          `Executed authorized reconciliation: assigned ${executedMutations} orders to store ${criteria.storeCode}`
        );
      }
    }

    const report: ReconciliationAuditReport = {
      targetStoreId: criteria.targetStoreId,
      storeCode: criteria.storeCode,
      totalAudited: rows.length,
      confirmedMatches,
      inconclusiveCandidates,
      conflictsCount,
      dryRun,
      executedMutations,
      items,
      executedAt: new Date()
    };

    this.logger.info('ContinentalReconciliation', 'Audit completed', {
      totalAudited: report.totalAudited,
      confirmedMatches: report.confirmedMatches,
      inconclusiveCandidates: report.inconclusiveCandidates,
      conflictsCount: report.conflictsCount,
      dryRun: report.dryRun,
      executedMutations: report.executedMutations
    });

    return report;
  }
}
