// ============================================================
// PolicyManager — BD_API_ZEISS Platform
// ============================================================
// Loads sync policies from the repository. Contains ZERO
// hardcoded cadences. Operational values will be persisted
// in integration.sync_policies and read at runtime.
// ============================================================

import { SyncPolicy, ISyncPolicyRepository } from '../contracts/repositories';
import { ILogger } from '../observability/Logger';

export class PolicyManager {
  constructor(
    private readonly policyRepo: ISyncPolicyRepository,
    private readonly logger: ILogger,
  ) {}

  /**
   * Load all enabled policies for a provider.
   * The engine calls this to discover what operations to run
   * and with what parameters.
   */
  async getEnabledPolicies(provider: string): Promise<SyncPolicy[]> {
    const policies = await this.policyRepo.findEnabledByProvider(provider);
    this.logger.info('PolicyManager', `Loaded ${policies.length} enabled policies`, { provider });
    return policies;
  }

  /**
   * Load a specific policy by composite key.
   * Returns null if the policy does not exist or is disabled.
   */
  async getPolicy(provider: string, domain: string, operation: string): Promise<SyncPolicy | null> {
    const policy = await this.policyRepo.findByKey(provider, domain, operation);
    if (policy && !policy.enabled) {
      this.logger.info('PolicyManager', 'Policy exists but is disabled', {
        provider, domain, operation,
      });
      return null;
    }
    return policy;
  }

  /**
   * Check whether a specific operation should run based on its policy
   * and the last sync timestamp.
   */
  shouldRun(policy: SyncPolicy, lastSync: Date | null): boolean {
    if (!policy.enabled) return false;
    if (!lastSync) return true;

    const elapsedMs = Date.now() - lastSync.getTime();
    const intervalMs = policy.interval_seconds * 1000;
    return elapsedMs >= intervalMs;
  }
}
