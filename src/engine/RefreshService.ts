// ============================================================
// RefreshService — BD_API_ZEISS Platform
// ============================================================
// On-demand refresh service. Reuses the same providers and
// repositories as the background sync — no logic duplication.
//
// Apps call this service (via future api_runtime) to request
// immediate data refresh without calling ZEISS directly.
// ============================================================

import {
  IOrdersRepository,
  IOrderDetailsRepository,
  ITrackingRepository,
  ICampaignsRepository,
  ILeadsRepository,
  IProductsRepository,
  IReceivablesRepository,
  IProviderHealthRepository,
} from '../contracts/repositories';
import {
  IOrdersListProvider,
  IOrderDetailProvider,
  ITrackingProvider,
  ICampaignsProvider,
  ILeadsProvider,
  IProductsProvider,
  IReceivablesProvider,
  IVoucherDetailProvider,
} from '../contracts/providers';
import { IOrderClassifier, ITrackingClassifier } from './Classifiers';
import { ILogger } from '../observability/Logger';
import { OrderDetailMapper, TrackingMapper, LeadMapper, ProductMapper, CampaignMapper } from './Mappers';
import { OrderStateInput } from '../contracts/types';

export interface RefreshDeps {
  detailProvider: IOrderDetailProvider;
  trackingProvider: ITrackingProvider;
  campaignsProvider: ICampaignsProvider;
  leadsProvider: ILeadsProvider;
  productsProvider: IProductsProvider;
  voucherDetailProvider: IVoucherDetailProvider;
  detailsRepo: IOrderDetailsRepository;
  trackingRepo: ITrackingRepository;
  campaignsRepo: ICampaignsRepository;
  leadsRepo: ILeadsRepository;
  productsRepo: IProductsRepository;
  orderClassifier: IOrderClassifier;
  trackingClassifier: ITrackingClassifier;
  logger: ILogger;
}

export interface RefreshResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
}

export class RefreshService {
  private readonly deps: RefreshDeps;
  private static readonly COMPONENT = 'RefreshService';

  constructor(deps: RefreshDeps) {
    this.deps = deps;
  }

  /**
   * Refresh leads for a specific campaign.
   * Calls LEAD-001 + LEAD-002 for the given campaignId.
   */
  async refreshLeadsByCampaign(campaignId: string): Promise<RefreshResult> {
    const result: RefreshResult = { success: true, itemsProcessed: 0, errors: [] };

    this.deps.logger.info(RefreshService.COMPONENT, 'Refreshing leads for campaign', { campaignId });

    try {
      const leads = await this.deps.leadsProvider.getLeads(campaignId);
      const normalizedLeads = leads.map(l => LeadMapper.normalize(l));
      await this.deps.leadsRepo.upsertMany(campaignId, normalizedLeads);
      result.itemsProcessed += normalizedLeads.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`LEAD-001 refresh failed: ${message}`);
      result.success = false;
    }

    try {
      const redeemed = await this.deps.leadsProvider.getRedeemedLeads(campaignId);
      const normalizedRedeemed = redeemed.map(l => LeadMapper.normalize(l));
      await this.deps.leadsRepo.upsertRedeemedMany(campaignId, normalizedRedeemed);
      result.itemsProcessed += normalizedRedeemed.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`LEAD-002 refresh failed: ${message}`);
      result.success = false;
    }

    return result;
  }

  /**
   * Refresh a single order detail via ORD-002.
   * Uses the same provider/repository as the background engine.
   */
  async refreshOrderDetail(orderNumber: string): Promise<RefreshResult> {
    const result: RefreshResult = { success: true, itemsProcessed: 0, errors: [] };

    this.deps.logger.info(RefreshService.COMPONENT, 'Refreshing order detail', { orderNumber });

    try {
      const rawDetail = await this.deps.detailProvider.getOrderDetail(orderNumber);
      const detail = OrderDetailMapper.minimize(orderNumber, rawDetail);
      await this.deps.detailsRepo.upsert(orderNumber, detail);
      result.itemsProcessed = 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`ORD-002 refresh failed: ${message}`);
      result.success = false;
    }

    return result;
  }

  /**
   * Refresh tracking for a specific order (if eligible).
   * Determines the NF internally based on local state.
   */
  async refreshTracking(orderNumber: string): Promise<RefreshResult> {
    const result: RefreshResult = { success: true, itemsProcessed: 0, errors: [] };

    this.deps.logger.info(RefreshService.COMPONENT, 'Refreshing tracking', {
      orderNumber,
    });

    try {
      const candidates = await this.deps.trackingRepo.findTrackingCandidatesForOrder(orderNumber);
      
      if (!candidates || candidates.length === 0) {
        result.errors.push('Cannot refresh tracking: Order candidate not found');
        result.success = false;
        return result;
      }

      for (const candidate of candidates) {
        const stateInput: OrderStateInput = { 
          status: candidate.raw_order_status, 
          codsit: candidate.raw_order_codsit 
        };

        if (this.deps.orderClassifier.isMutable(stateInput)) {
          result.errors.push(`Order is mutable (not billed logistics ready) for NF ${candidate.nf_number}`);
          result.success = false;
          continue;
        }

        if (this.deps.orderClassifier.isCancelled(stateInput)) {
          result.errors.push(`Order is cancelled for NF ${candidate.nf_number}`);
          result.success = false;
          continue;
        }

        if (!this.deps.orderClassifier.isBilledLogisticsReady(stateInput)) {
          result.errors.push(`Order is not billed and logistics ready for NF ${candidate.nf_number}`);
          result.success = false;
          continue;
        }

        if (!candidate.nf_number || candidate.nf_number.trim() === '') {
          result.errors.push('Cannot refresh tracking: No NF number found for order');
          result.success = false;
          continue;
        }

        if (this.deps.trackingClassifier.isTerminal(candidate.tracking_state)) {
          result.errors.push(`Tracking is already terminal for NF ${candidate.nf_number}`);
          result.success = false;
          continue;
        }

        const rawTrackingData = await this.deps.trackingProvider.getTracking(candidate.nf_number);
        const trackingData = TrackingMapper.minimize(rawTrackingData);
        await this.deps.trackingRepo.upsert(orderNumber, candidate.nf_number, trackingData);
        result.itemsProcessed++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`TRK-001 refresh failed: ${message}`);
      result.success = false;
    }

    return result;
  }

  /**
   * Refresh voucher detail via VCH-001 (ON_DEMAND).
   * Returns the data directly without persistence (transient).
   */
  async refreshVoucherDetail(
    campaignId: string,
    voucherCode: string,
  ): Promise<{ data: Record<string, unknown> | null; error: string | null }> {
    this.deps.logger.info(RefreshService.COMPONENT, 'Fetching voucher detail on-demand', {
      campaignId,
    });

    try {
      const data = await this.deps.voucherDetailProvider.getVoucherDetail(
        campaignId,
        voucherCode,
      );
      return { data, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: null, error: message };
    }
  }

  /**
   * Refresh products catalog (PRD-001).
   */
  async refreshProducts(): Promise<RefreshResult> {
    const result: RefreshResult = { success: true, itemsProcessed: 0, errors: [] };

    this.deps.logger.info(RefreshService.COMPONENT, 'Refreshing products catalog');

    try {
      const products = await this.deps.productsProvider.getProducts();
      const normalizedProducts = products.map(p => ProductMapper.normalize(p));
      await this.deps.productsRepo.upsertMany(normalizedProducts);
      result.itemsProcessed = normalizedProducts.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`PRD-001 refresh failed: ${message}`);
      result.success = false;
    }

    return result;
  }

  /**
   * Refresh campaigns catalog (CAM-001).
   */
  async refreshCampaigns(): Promise<RefreshResult> {
    const result: RefreshResult = { success: true, itemsProcessed: 0, errors: [] };

    this.deps.logger.info(RefreshService.COMPONENT, 'Refreshing campaigns');

    try {
      const campaigns = await this.deps.campaignsProvider.getCampaigns();
      const normalizedCampaigns = campaigns.map(c => CampaignMapper.normalize(c));
      await this.deps.campaignsRepo.upsertMany(normalizedCampaigns);
      result.itemsProcessed = normalizedCampaigns.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`CAM-001 refresh failed: ${message}`);
      result.success = false;
    }

    return result;
  }
}
