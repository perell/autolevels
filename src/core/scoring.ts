import type { Config } from './config';
import type { Bias, MondayLevels, Zone } from './types';

export interface Score {
  score: number;
  parts: string[];
}

/**
 * Confluence score for a zone:
 *  +2 Monday high or low inside the zone or within `mondayProximity` points
 *  +1 Monday midpoint inside / near the zone
 *  +1 zone in the bias direction (buy + bullish, sell + bearish)
 */
export function scoreZone(zone: Zone, monday: MondayLevels | null, bias: Bias, cfg: Config): Score {
  const parts: string[] = [];
  let score = 0;
  const near = (level: number) =>
    level >= zone.low - cfg.mondayProximity && level <= zone.high + cfg.mondayProximity;

  if (monday?.complete) {
    if (near(monday.high) || near(monday.low)) {
      score += 2;
      parts.push(near(monday.high) ? 'monday-high' : 'monday-low');
    }
    if (near(monday.mid)) {
      score += 1;
      parts.push('monday-mid');
    }
  }
  if ((zone.side === 'buy' && bias === 'bullish') || (zone.side === 'sell' && bias === 'bearish')) {
    score += 1;
    parts.push(`bias-${bias}`);
  }
  return { score, parts };
}
