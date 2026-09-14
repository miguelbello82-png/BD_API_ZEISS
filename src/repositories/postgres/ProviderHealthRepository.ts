import { IDatabaseExecutor } from '../../config/db';
import { IProviderHealthRepository, ProviderHealthRecord } from '../../contracts/repositories';

export class PgProviderHealthRepository implements IProviderHealthRepository {
  constructor(private db: IDatabaseExecutor) {}

  async findByKey(provider: string, domain: string, operation: string): Promise<ProviderHealthRecord | null> {
    const query = `
      SELECT provider, domain, operation, status, last_success, last_failure
      FROM integration.provider_health
      WHERE provider = $1 AND domain = $2 AND operation = $3
    `;
    const result = await this.db.query<ProviderHealthRecord>(query, [provider, domain, operation]);
    return result.length > 0 ? result[0] : null;
  }

  async recordSuccess(provider: string, domain: string, operation: string): Promise<void> {
    const query = `
      INSERT INTO integration.provider_health (provider, domain, operation, status, last_success)
      VALUES ($1, $2, $3, 'HEALTHY', CURRENT_TIMESTAMP)
      ON CONFLICT (provider, domain, operation)
      DO UPDATE SET
        status = 'HEALTHY',
        last_success = CURRENT_TIMESTAMP
    `;
    await this.db.query(query, [provider, domain, operation]);
  }

  async recordFailure(provider: string, domain: string, operation: string): Promise<void> {
    const query = `
      INSERT INTO integration.provider_health (provider, domain, operation, status, last_failure)
      VALUES ($1, $2, $3, 'DEGRADED', CURRENT_TIMESTAMP)
      ON CONFLICT (provider, domain, operation)
      DO UPDATE SET
        status = 'DEGRADED',
        last_failure = CURRENT_TIMESTAMP
    `;
    await this.db.query(query, [provider, domain, operation]);
  }
}
