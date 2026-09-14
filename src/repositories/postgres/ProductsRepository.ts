import { IDatabaseExecutor } from '../../config/db';
import { IProductsRepository } from '../../contracts/repositories';
import { ProductRecord } from '../../contracts/types';

export class PgProductsRepository implements IProductsRepository {
  constructor(private db: IDatabaseExecutor) {}

  async upsertMany(products: ProductRecord[]): Promise<void> {
    if (products.length === 0) return;

    await this.db.transaction(async (client) => {
      for (const product of products) {
        // Mapping ProductRecord to zeiss.products table
        const query = `
          INSERT INTO zeiss.products (zeiss_product_code, name, category, design, material, updated_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          ON CONFLICT (zeiss_product_code)
          DO UPDATE SET
            name = EXCLUDED.name,
            category = EXCLUDED.category,
            design = EXCLUDED.design,
            material = EXCLUDED.material,
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          product.product_id,
          product.name,
          product.group, // map group -> category
          product.family, // map family -> design
          product.sku // map sku -> material
        ]);
      }
    });
  }
}
