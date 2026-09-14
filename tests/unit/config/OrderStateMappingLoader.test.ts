import { OrderStateMappingLoader } from '../../../src/config/OrderStateMappingLoader';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs');

describe('OrderStateMappingLoader', () => {
  const mockPath = path.resolve(__dirname, '../../../src/config/../../config/zeiss/order-state-mapping.json');

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('fails fast if config is missing', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    expect(() => OrderStateMappingLoader.load()).toThrow(/Missing configuration file/);
  });

  it('fails if config is invalid json', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('invalid-json');
    expect(() => OrderStateMappingLoader.load()).toThrow(/Invalid JSON/);
  });

  it('fails if config is missing required fields', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      cancelled: { field: 'status' }
    }));
    expect(() => OrderStateMappingLoader.load()).toThrow(/OrderStateMappingLoader: "cancelled\.values" must be a non-empty array/);
  });

  it('loads valid config successfully', () => {
    const validConfig = {
      cancelled: { field: 'status', values: ['Cancelado'] },
      billed: { codsit: ['6.1'] }
    };
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(validConfig));
    const config = OrderStateMappingLoader.load();
    expect(config).toEqual(validConfig);
  });
});
