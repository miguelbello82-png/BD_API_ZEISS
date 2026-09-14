import { ProductsProvider } from '../../src/providers/products';
import { ZeissApiClient } from '../../src/config/client';
import { zeissConfig } from '../../src/config/config';

describe('ProductsProvider Unit Tests', () => {
  let provider: ProductsProvider;

  beforeEach(() => {
    provider = new ProductsProvider();
    jest.spyOn(ZeissApiClient.prototype, 'fetch').mockClear();
    process.env.ZEISS_COUNTRY_ID = 'BR';
    process.env.ZEISS_CNPJ = '12345';
  });

  it('PRD-001: should fetch products with correct base and path, unwrapping sao.produtos', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({
      sao: { produtos: [{ id: 'P1' }] }
    });
    const result = await provider.getProducts();
    expect(result).toEqual([{ id: 'P1' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.ordersBaseUrl, '/prd/produtos/lista/BR/12345', expect.anything());
  });

  it('PRD-001: should throw error if envelope is invalid', async () => {
    jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({ invalid: true });
    await expect(provider.getProducts()).rejects.toThrow('ZEISS API Contract Error');
  });
});
