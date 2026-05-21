export interface PassiveRateLimiterOpts {
  shortS: number;
  longN: number;
  longS: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class PassiveRateLimiter {
  private shortWindowTokens = 1;
  private longWindowTokens: number;
  private readonly shortS: number;
  private readonly longN: number;
  private readonly longS: number;

  constructor(opts: PassiveRateLimiterOpts) {
    this.shortS = opts.shortS;
    this.longN = opts.longN;
    this.longS = opts.longS;
    this.longWindowTokens = opts.longN;

    const shortTimer = setInterval(() => {
      this.shortWindowTokens = Math.min(1, this.shortWindowTokens + 1);
    }, this.shortS * 1000);
    shortTimer.unref?.();

    const longTimer = setInterval(() => {
      this.longWindowTokens = Math.min(this.longN, this.longWindowTokens + 1);
    }, this.longS * 1000);
    longTimer.unref?.();
  }

  tryConsume(): boolean {
    // rev-2 CONCERN-MR-1 explicit AND logic: BOTH windows must have tokens for consume() to succeed. Either window alone is insufficient. Short window prevents rapid bursts; long window prevents sustained drainage.
    if (this.shortWindowTokens > 0 && this.longWindowTokens > 0) {
      this.shortWindowTokens -= 1;
      this.longWindowTokens -= 1;
      return true;
    }
    return false;
  }

  snapshot(): {
    shortWindowTokens: number;
    longWindowTokens: number;
    shortS: number;
    longS: number;
    longN: number;
  } {
    return {
      shortWindowTokens: this.shortWindowTokens,
      longWindowTokens: this.longWindowTokens,
      shortS: this.shortS,
      longS: this.longS,
      longN: this.longN,
    };
  }
}

export function passiveRateLimiterOptsFromEnv(): PassiveRateLimiterOpts {
  return {
    shortS: positiveInteger(process.env.MAI_PASSIVE_RATE_SHORT_S, 30),
    longN: positiveInteger(process.env.MAI_PASSIVE_RATE_LONG_N, 5),
    longS: positiveInteger(process.env.MAI_PASSIVE_RATE_LONG_S, 60),
  };
}
