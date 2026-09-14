import { OrdersMapper, OrderDetailMapper, TrackingMapper, ContractMappingError } from '../../../src/engine/Mappers';

describe('Mappers', () => {
  describe('OrdersMapper', () => {
    it('normalizes valid payload without using id fallback', () => {
      const raw = {
        'nr-pedido': '123',
        'os-cliente': 'OS1',
        status: 'Faturado',
        codsit: '6.1',
        id: 'fake-id' // Should be ignored
      };
      
      const record = OrdersMapper.normalizeOrderListItem(raw);
      expect(record.order_number).toBe('123');
      expect((record as any).id).toBeUndefined(); // ensure id is not present
      expect(record.status).toBe('Faturado');
    });
  });

  describe('OrderDetailMapper', () => {
    it('payload ORD-002 real valido com nf -> InvoiceReference correta', () => {
      const raw = {
        situacao: 'Faturado',
        nf: [{ nr: '123456', serie: '1' }]
      };
      const detail = OrderDetailMapper.minimize('100', raw);
      expect(detail.invoices.length).toBe(1);
      expect(detail.invoices[0].number).toBe('123456');
      expect(detail.invoices[0].series).toBe('1');
    });

    it('payload valido sem NF -> invoices=[]', () => {
      const raw = { situacao: 'Faturado', nf: [] };
      const detail = OrderDetailMapper.minimize('100', raw);
      expect(detail.invoices.length).toBe(0);
    });

    it('payload estruturalmente invalido -> ContractMappingError', () => {
      const raw = { someUnknownField: 'yes' }; // No situacao, status, or nf
      expect(() => OrderDetailMapper.minimize('100', raw)).toThrow(ContractMappingError);
    });

    it('nf = string -> ContractMappingError', () => {
      const raw = { situacao: 'Faturado', nf: '123' };
      expect(() => OrderDetailMapper.minimize('100', raw)).toThrow(ContractMappingError);
    });

    it('nf = object -> ContractMappingError', () => {
      const raw = { situacao: 'Faturado', nf: { nr: '123' } };
      expect(() => OrderDetailMapper.minimize('100', raw)).toThrow(ContractMappingError);
    });

    it('campo inventado nfs NAO deve ser tratado como NF', () => {
      const raw = { situacao: 'Faturado', nfs: [{ nr: '123' }] }; // nfs instead of nf
      const detail = OrderDetailMapper.minimize('100', raw);
      expect(detail.invoices.length).toBe(0); // Ignores nfs
    });

    it('CPF/raw payload nao aparecem no DTO final', () => {
      const raw = { situacao: 'Faturado', cpf: '12345678900', nf: [] };
      const detail = OrderDetailMapper.minimize('100', raw);
      expect((detail as any).cpf).toBeUndefined();
    });
  });

  describe('TrackingMapper', () => {
    it('[] valido -> retorna vazio', () => {
      const result = TrackingMapper.minimize([]);
      expect(result).toEqual([]);
    });

    it('Array com multiplos registros', () => {
      const raw = [
        { status: 'DELIVERED', data: '2026-01-01', data_entrega: '2026-01-01' },
        { status_chegada: 'CHEGOU' }
      ];
      const result = TrackingMapper.minimize(raw);
      expect(result.length).toBe(2);
      expect(result[0].status).toBe('DELIVERED');
      expect(result[0].data_entrega).toBe('2026-01-01');
      expect(result[1].status_chegada).toBe('CHEGOU');
    });

    it('null -> ContractMappingError', () => {
      expect(() => TrackingMapper.minimize(null)).toThrow(ContractMappingError);
    });

    it('object envelope -> ContractMappingError', () => {
      expect(() => TrackingMapper.minimize({ events: [] })).toThrow(ContractMappingError);
    });

    it('campos de estado preservados, signed URL ignorada', () => {
      const raw = [{ status_entrega: 'Sim', signed_url: 'https://...', token: '123' }];
      const result = TrackingMapper.minimize(raw);
      expect(result[0].status_entrega).toBe('Sim');
      expect((result[0] as any).signed_url).toBeUndefined();
      expect((result[0] as any).token).toBeUndefined();
    });
  });
});
