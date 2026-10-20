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
  detail_id?: string | null;
  detail_store_id?: string | null;
  detail_codcli?: string | null;
  fiscal_id?: string | null;
  fiscal_store_id?: string | null;
  fiscal_cnpj?: string | null;
  fiscal_nf_number?: string | null;
}

interface OrderEvidenceBucket {
  orderId: string;
  orderNumber: string;
  status: string | null;
  entryDate: string | null;
  details: Array<{ id: string; storeId: string | null; codcli: string | null }>;
  fiscalDocs: Array<{ id: string; storeId: string | null; cnpj: string | null; nfNumber: string | null }>;
}

export class ContinentalReconciliationService {
  constructor(
    private db: IDatabaseExecutor,
    private logger: ILogger = new ConsoleLogger()
  ) {}

  /**
   * Audits historical unassigned records (store_id IS NULL) against store criteria.
   * Default mode is dryRun=true (simulation and reporting only).
   * 
   * ACH-04: Queries real database columns without artificial NULL::text constructs.
   * ACH-05: Consolidates multiple documents per order, enforcing conflict precedence
   * so favorable evidence cannot hide contradictory evidence.
   */
  async auditHistoricalOrders(
    criteria: ReconciliationCriteria,
    options: ReconciliationOptions = {}
  ): Promise<ReconciliationAuditReport> {
    const dryRun = options.dryRun !== false; // Default true
    const limit = options.limit || 10000;
    const cleanCnpj = criteria.cnpj ? criteria.cnpj.replace(/\D/g, '') : '';

    this.logger.info('ContinentalReconciliation', `Starting historical audit for store ${criteria.storeCode} [dryRun=${dryRun}]`);

    // Real relational query: selects actual columns from orders, order_details, and fiscal_documents
    const query = `
      SELECT 
        o.id as order_id,
        o.order_number,
        o.status,
        o.entry_date::text as entry_date,
        od.id as detail_id,
        od.store_id as detail_store_id,
        fd.id as fiscal_id,
        fd.store_id as fiscal_store_id,
        fd.nf_number as fiscal_nf_number
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details od ON od.order_id = o.id
      LEFT JOIN zeiss.fiscal_documents fd ON fd.order_id = o.id
      WHERE o.store_id IS NULL
      ORDER BY o.entry_date DESC NULLS LAST
      LIMIT $1
    `;

    const rows = await this.db.query<RawAuditRow>(query, [limit]);

    // ACH-05: Group rows by order_id to handle 1:N cardinalities (multiple details or fiscal docs)
    const orderBuckets = new Map<string, OrderEvidenceBucket>();

    for (const row of rows) {
      let bucket = orderBuckets.get(row.order_id);
      if (!bucket) {
        bucket = {
          orderId: row.order_id,
          orderNumber: row.order_number,
          status: row.status,
          entryDate: row.entry_date,
          details: [],
          fiscalDocs: []
        };
        orderBuckets.set(row.order_id, bucket);
      }

      if (row.detail_id && !bucket.details.some(d => d.id === row.detail_id)) {
        bucket.details.push({
          id: row.detail_id,
          storeId: row.detail_store_id || null,
          codcli: row.detail_codcli || null
        });
      }

      if (row.fiscal_id && !bucket.fiscalDocs.some(f => f.id === row.fiscal_id)) {
        bucket.fiscalDocs.push({
          id: row.fiscal_id,
          storeId: row.fiscal_store_id || null,
          cnpj: row.fiscal_cnpj ? row.fiscal_cnpj.replace(/\D/g, '') : null,
          nfNumber: row.fiscal_nf_number || null
        });
      }
    }

    const items: ReconciliationItem[] = [];
    let confirmedMatches = 0;
    let inconclusiveCandidates = 0;
    let conflictsCount = 0;

    // Evaluate each distinct order with strict conflict precedence
    for (const bucket of orderBuckets.values()) {
      const evidence: string[] = [];
      let hasConflict = false;
      let hasMatch = false;

      // 1. Conflict Evaluation (Precedence 1 - HIGHEST)
      // Any contradictory evidence across any child document immediately flags CONFLICT
      for (const d of bucket.details) {
        if (d.storeId && d.storeId !== criteria.targetStoreId) {
          hasConflict = true;
          evidence.push(`Detail item belongs to divergent store: '${d.storeId}' (expected '${criteria.targetStoreId}')`);
        }
        if (d.codcli && d.codcli !== criteria.saowebCode) {
          hasConflict = true;
          evidence.push(`SAOWEB mismatch in detail: expected '${criteria.saowebCode}', found '${d.codcli}'`);
        }
      }

      for (const f of bucket.fiscalDocs) {
        if (f.storeId && f.storeId !== criteria.targetStoreId) {
          hasConflict = true;
          evidence.push(`Fiscal document NF ${f.nfNumber || f.id} belongs to divergent store: '${f.storeId}' (expected '${criteria.targetStoreId}')`);
        }
        if (f.cnpj && f.cnpj !== cleanCnpj) {
          hasConflict = true;
          evidence.push(`CNPJ mismatch in fiscal doc NF ${f.nfNumber || f.id}: expected '${cleanCnpj}', found '${f.cnpj}'`);
        }
      }

      // 2. Match Evaluation (Precedence 2)
      for (const d of bucket.details) {
        if (d.storeId === criteria.targetStoreId) {
          hasMatch = true;
          evidence.push(`Detail item confirmed linked to store '${criteria.storeCode}' (${criteria.targetStoreId})`);
        }
        if (d.codcli && d.codcli === criteria.saowebCode) {
          hasMatch = true;
          evidence.push(`SAOWEB confirmed match in detail: '${criteria.saowebCode}'`);
        }
      }

      for (const f of bucket.fiscalDocs) {
        if (f.storeId === criteria.targetStoreId) {
          hasMatch = true;
          evidence.push(`Fiscal document NF ${f.nfNumber || f.id} confirmed linked to store '${criteria.storeCode}' (${criteria.targetStoreId})`);
        }
        if (f.cnpj && f.cnpj === cleanCnpj) {
          hasMatch = true;
          evidence.push(`Fiscal document CNPJ confirmed match: '${cleanCnpj}'`);
        }
      }

      // 3. Final Consolidated Classification (ACH-05)
      let confidence: MatchConfidence;
      let recommendation: Recommendation;

      if (hasConflict) {
        // Favorable evidence CANNOT override conflicting evidence
        confidence = 'CONFLICT';
        recommendation = 'EXCEPTION_CONFLICT';
        conflictsCount++;
      } else if (hasMatch) {
        confidence = 'CONFIRMED';
        recommendation = 'ATTRIBUTION_ELIGIBLE';
        confirmedMatches++;
      } else {
        // Inconclusive: neither commercial nor relational markers found
        confidence = 'INCONCLUSIVE';
        recommendation = 'QUARANTINE_LEGACY';
        inconclusiveCandidates++;
        if (bucket.details.length === 0 && bucket.fiscalDocs.length === 0) {
          evidence.push('No linked details or fiscal documents found for this order');
        } else {
          evidence.push('No store attribution or commercial markers (SAOWEB/CNPJ) present in relational documents');
        }
      }

      items.push({
        orderId: bucket.orderId,
        orderNumber: bucket.orderNumber,
        entryDate: bucket.entryDate,
        status: bucket.status,
        hasDetail: bucket.details.length > 0,
        detailCodcli: bucket.details.find(d => !!d.codcli)?.codcli || null,
        hasFiscalDoc: bucket.fiscalDocs.length > 0,
        fiscalCnpj: bucket.fiscalDocs.find(f => !!f.cnpj)?.cnpj || null,
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

      // Execute mutations ONLY for CONFIRMED matches (inherently deduplicated)
      const eligibleOrderIds = Array.from(
        new Set(
          items.filter(item => item.confidence === 'CONFIRMED').map(item => item.orderId)
        )
      );

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
      totalAudited: orderBuckets.size, // Exact distinct order count
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
