import { DateParser, OrdersMapper, OrderDetailMapper, TrackingMapper, CampaignMapper, ReceivableMapper, ContractMappingError } from '../../../src/engine/Mappers';

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

    it('parses ORD-001 dates strictly', () => {
      const raw = {
        'nr-pedido': '123',
        'data-entrada': '2026-09-15',
        'previsao-entrega': '2026-09-16'
      };
      const record = OrdersMapper.normalizeOrderListItem(raw);
      expect(record.entry_date).toBe('2026-09-15');
      expect(record.expected_date).toBe('2026-09-16');
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

    it('parses ORD-002 dates strictly', () => {
      const raw = {
        situacao: 'Faturado',
        entrada: { data: '09/15/2026' },
        previsao: '2026-09-16'
      };
      const detail = OrderDetailMapper.minimize('100', raw);
      expect(detail.entry_date).toBe('2026-09-15');
      expect(detail.expected_date).toBe('2026-09-16');
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

  describe('CampaignMapper', () => {
    it('normalizes valid campaign payload using real CAM-001 keys', () => {
      const payload = {
        idcampanha: 'CMP-001',
        idtipocampanha: 'TYPE-1',
        titulo: 'Campanha Teste',
        slogan: 'Teste',
        descricao: 'Teste Desc',
        datainicial: '25-06-2023',
        datafinal: '31-12-2099',
        ativosn: 'S',
        imagem_campanha: 'img.png',
        aceite: true,
        vouchers: 10,
        incentivo: 'brindes'
      };
      const result = CampaignMapper.normalize(payload);
      expect(result.campaign_id).toBe('CMP-001');
      expect(result.title).toBe('Campanha Teste');
      expect(result.start_date).toBe('2023-06-25');
      expect(result.end_date).toBe('2099-12-31');
      expect(result.status).toBe('S');
      expect(result.aceite).toBe(true);
      expect(result.incentive_type).toBe('brindes');
    });

    it('throws if idcampanha is missing', () => {
      const payload = { titulo: 'Campanha Teste' };
      expect(() => CampaignMapper.normalize(payload)).toThrow('Campaign missing required idcampanha identifier');
    });

    it('returns null for empty dates', () => {
      const payload = { idcampanha: '1', datainicial: '', datafinal: null };
      const result = CampaignMapper.normalize(payload);
      expect(result.start_date).toBeNull();
      expect(result.end_date).toBeNull();
    });

    it('throws ContractMappingError on malformed dates', () => {
      const payload = { idcampanha: '1', datainicial: '2023/06/25' };
      expect(() => CampaignMapper.normalize(payload)).toThrow(ContractMappingError);
    });
  });

  describe('ReceivableMapper (FIN-001 strict calendar validation)', () => {
    it('normalizes valid dates to YYYY-MM-DD', () => {
      const validCases = [
        { input: '05/07/2026', expected: '2026-07-05' },
        { input: '29/02/2024', expected: '2024-02-29' },
        { input: '2026-08-04', expected: '2026-08-04' }
      ];

      for (const t of validCases) {
        const payload = { boleto: '123', vencimento: t.input, valor: '100.00' };
        const result = ReceivableMapper.normalize(payload);
        expect(result.due_date).toBe(t.expected);
      }
    });

    it('throws ContractMappingError on impossible dates (preventing silent rollover)', () => {
      const invalidCases = [
        '31/02/2026',
        '29/02/2025',
        '00/07/2026',
        '15/13/2026',
        '2026-02-31',
        '2025-02-29',
        '2026-00-10',
        'malformed string'
      ];

      for (const input of invalidCases) {
        const payload = { boleto: '123', vencimento: input, valor: '100.00' };
        expect(() => ReceivableMapper.normalize(payload)).toThrow(ContractMappingError);
      }
    });
  });

  describe('DateParser', () => {
    it('parses YYYY-MM-DD correctly', () => {
      expect(DateParser.parse('2026-09-15', 'YYYY-MM-DD', 'TEST')).toBe('2026-09-15');
    });

    it('parses MM/DD/YYYY correctly', () => {
      expect(DateParser.parse('09/15/2026', 'MM/DD/YYYY', 'TEST')).toBe('2026-09-15');
    });

    it('throws on invalid rollover date', () => {
      expect(() => DateParser.parse('2026-02-31', 'YYYY-MM-DD', 'TEST')).toThrow(ContractMappingError);
      expect(() => DateParser.parse('02/31/2026', 'MM/DD/YYYY', 'TEST')).toThrow(ContractMappingError);
    });

    it('returns null on empty input', () => {
      expect(DateParser.parse('', 'YYYY-MM-DD', 'TEST')).toBeNull();
      expect(DateParser.parse(undefined, 'MM/DD/YYYY', 'TEST')).toBeNull();
    });
  });
});
