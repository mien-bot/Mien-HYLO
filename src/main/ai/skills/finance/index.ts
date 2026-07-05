/**
 * Finance Skills Registry
 *
 * Central export for all finance AI skills.
 * Uses direct imports (not `export { } from`) so Vite/Rollup doesn't
 * tree-shake the system prompt constants out of the bundle.
 */

import {
  EARNINGS_REVIEW_SYSTEM,
  buildEarningsReviewPrompt,
  type EarningsContext,
} from './earnings-review'
import { VALUATION_SYSTEM, buildValuationPrompt, type ValuationContext } from './valuation'
import {
  MARKET_RESEARCH_SYSTEM,
  buildMarketResearchPrompt,
  type MarketResearchContext,
} from './market-research'
import {
  TECHNICAL_ANALYSIS_SYSTEM,
  buildTechnicalAnalysisPrompt,
  type TechnicalContext,
} from './technical-analysis'
import {
  RISK_ASSESSMENT_SYSTEM,
  buildRiskAssessmentPrompt,
  type RiskContext,
} from './risk-assessment'
import {
  SECTOR_COMPARISON_SYSTEM,
  buildSectorComparisonPrompt,
  type SectorComparisonContext,
} from './sector-comparison'

export {
  EARNINGS_REVIEW_SYSTEM,
  buildEarningsReviewPrompt,
  type EarningsContext,
  VALUATION_SYSTEM,
  buildValuationPrompt,
  type ValuationContext,
  MARKET_RESEARCH_SYSTEM,
  buildMarketResearchPrompt,
  type MarketResearchContext,
  TECHNICAL_ANALYSIS_SYSTEM,
  buildTechnicalAnalysisPrompt,
  type TechnicalContext,
  RISK_ASSESSMENT_SYSTEM,
  buildRiskAssessmentPrompt,
  type RiskContext,
  SECTOR_COMPARISON_SYSTEM,
  buildSectorComparisonPrompt,
  type SectorComparisonContext,
}

export type FinanceSkill =
  | 'earnings-review'
  | 'valuation'
  | 'market-research'
  | 'technical-analysis'
  | 'risk-assessment'
  | 'sector-comparison'

const _skills: Record<FinanceSkill, string> = {
  'earnings-review': EARNINGS_REVIEW_SYSTEM,
  valuation: VALUATION_SYSTEM,
  'market-research': MARKET_RESEARCH_SYSTEM,
  'technical-analysis': TECHNICAL_ANALYSIS_SYSTEM,
  'risk-assessment': RISK_ASSESSMENT_SYSTEM,
  'sector-comparison': SECTOR_COMPARISON_SYSTEM,
}

export function getFinanceSkillPrompt(skill: FinanceSkill): string {
  return _skills[skill]
}
