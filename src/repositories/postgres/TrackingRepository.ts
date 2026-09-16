import { IDatabaseExecutor } from '../../config/db';
import { ITrackingRepository } from '../../contracts/repositories';
import { TrackingCandidate, TrackingEventRecord } from '../../contracts/types';

interface TrackingDbRow {
  order_id: string;
  order_number: string;
  raw_order_status: string | null;
  raw_order_codsit: string | null;
  detail_status?: string | null;
  nf_number: string;
}

export class PgTrackingRepository implements ITrackingRepository {
  constructor(private db: IDatabaseExecutor) {}

  async upsert(orderNumber: string, nfNumber: string, events: TrackingEventRecord[]): Promise<void> {
    if (events.length === 0) return;

    await this.db.transaction(async (client) => {
      const orderQuery = `SELECT id FROM zeiss.orders WHERE order_number = $1`;
      const orders = await client.query<{id: string}>(orderQuery, [orderNumber]);
      if (orders.length === 0) {
        throw new Error(`Order ${orderNumber} not found when upserting tracking`);
      }
      const orderId = orders[0].id;

      for (const event of events) {
        const query = `
          INSERT INTO zeiss.tracking_events (
            order_id,
            nf_number,
            status,
            description,
            event_date,
            status_aprovada,
            status_inicio,
            status_chegada,
            status_entrega,
            data_entrega,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
          ON CONFLICT (order_id, nf_number, status, event_date)
          DO NOTHING
        `;
        await client.query(query, [
          orderId,
          nfNumber,
          event.status || null,
          null, // description not needed
          event.data || null, // preserve string
          event.status_aprovada || null,
          event.status_inicio || null,
          event.status_chegada || null,
          event.status_entrega || null,
          event.data_entrega || null // preserve string
        ]);
      }
    });
  }

  async findTrackingCandidates(lastOrderId?: string, lastNfNumber?: string, limit?: number): Promise<TrackingCandidate[]> {
    if (typeof limit !== 'number' || limit <= 0) {
      throw new Error('CONFIGURATION_ERROR: Tracking requires explicit batch limit from policy config');
    }

    // Deterministic pagination using order_id and nf_number
    // We do not aggregate tracking state yet because selection rule is unresolved. tracking_state = null.
    const query = `
      SELECT
        o.id as order_id,
        o.order_number,
        o.status as raw_order_status,
        o.codsit as raw_order_codsit,
        COALESCE(od.raw_status, od.raw_situacao) as detail_status,
        fd.nf_number
      FROM zeiss.orders o
      JOIN zeiss.fiscal_documents fd ON o.id = fd.order_id
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
      ${lastOrderId && lastNfNumber ? 'WHERE (o.id, fd.nf_number) > ($1, $2)' : ''}
      ORDER BY o.id ASC, fd.nf_number ASC
      LIMIT $${lastOrderId && lastNfNumber ? '3' : '1'}
    `;

    const params = lastOrderId && lastNfNumber ? [lastOrderId, lastNfNumber, limit] : [limit];
    const rows = await this.db.query<TrackingDbRow>(query, params);

    return rows.map(row => ({
      order_id: row.order_id,
      order_number: row.order_number,
      raw_order_status: row.raw_order_status,
      raw_order_codsit: row.raw_order_codsit,
      detail_status: row.detail_status ? String(row.detail_status) : null,
      nf_number: row.nf_number,
      tracking_state: null
    }));
  }

  async findTrackingCandidatesByDate(startDate: string, endDate: string): Promise<TrackingCandidate[]> {
    const query = `
      SELECT
        o.id as order_id,
        o.order_number,
        o.status as raw_order_status,
        o.codsit as raw_order_codsit,
        COALESCE(od.raw_status, od.raw_situacao) as detail_status,
        fd.nf_number
      FROM zeiss.orders o
      JOIN zeiss.fiscal_documents fd ON o.id = fd.order_id
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
      WHERE o.order_date >= $1 AND o.order_date <= $2
      ORDER BY o.id ASC
    `;
    const rows = await this.db.query<TrackingDbRow>(query, [startDate, endDate]);
    return rows.map(row => ({
      order_id: row.order_id,
      order_number: row.order_number,
      raw_order_status: row.raw_order_status,
      raw_order_codsit: row.raw_order_codsit,
      detail_status: row.detail_status ? String(row.detail_status) : null,
      nf_number: row.nf_number,
      tracking_state: null
    }));
  }

  async findTrackingCandidatesForOrder(orderNumber: string): Promise<TrackingCandidate[]> {
    const query = `
      SELECT
        o.id as order_id,
        o.order_number,
        o.status as raw_order_status,
        o.codsit as raw_order_codsit,
        COALESCE(od.raw_status, od.raw_situacao) as detail_status,
        fd.nf_number
      FROM zeiss.orders o
      JOIN zeiss.fiscal_documents fd ON o.id = fd.order_id
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
      WHERE o.order_number = $1
    `;
    const rows = await this.db.query<TrackingDbRow>(query, [orderNumber]);

    return rows.map(row => ({
      order_id: row.order_id,
      order_number: row.order_number,
      raw_order_status: row.raw_order_status,
      raw_order_codsit: row.raw_order_codsit,
      detail_status: row.detail_status ? String(row.detail_status) : null,
      nf_number: row.nf_number,
      tracking_state: null
    }));
  }
}
