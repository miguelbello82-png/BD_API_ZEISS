export interface IClock {
  now(): number;
}

export interface ISleeper {
  sleep(ms: number): Promise<void>;
}

export class RealClock implements IClock {
  now(): number {
    return Date.now();
  }
}

export class RealSleeper implements ISleeper {
  async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
