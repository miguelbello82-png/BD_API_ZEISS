import { OrdersProvider } from '../../src/providers/orders';
import { ZeissApiClient } from '../../src/config/client';
import { zeissConfig } from '../../src/config/config';

describe('OrdersProvider Unit Tests', () => {
  let provider: OrdersProvider;

  beforeEach(() => {
    provider = new OrdersProvider();
    jest.spyOn(ZeissApiClient.prototype, 'fetch').mockClear();
    process.env.ZEISS_COUNTRY_ID = 'BR';
    process.env.ZEISS_CNPJ = '12345';
    process.env.ZEISS_SAOWEB_CODE = 'SW1';
  });

  it('ORD-001: should unwrap {pedidos: [...]} correctly and check path', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({ pedidos: [{ id: '123' }] });
    const result = await provider.getOrders('start', 'end', 'PENDING');
    expect(result).toEqual([{ id: '123' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.ordersBaseUrl, '/prd/pedidos/data/12345/BR/start/end/PENDING', expect.anything());
  });

  it('ORD-002: should fetch single order correctly with POST', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({ id: '123', status: 'OK' });
    const result = await provider.getOrderDetail('123');
    expect(result).toEqual({ id: '123', status: 'OK' });
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.ordersBaseUrl, '/prd/pedidos/detalhe', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('123')
    }));
  });

  it('TRK-001: should fetch tracking by order id correctly', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({ status: 'ABC' });
    const result = await provider.getTracking('NF123');
    expect(result).toEqual({ status: 'ABC' });
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.trackingBaseUrl, '/prd/pedidos/tracking/drivin/BR/SW1/NF123', expect.anything());
  });
});
