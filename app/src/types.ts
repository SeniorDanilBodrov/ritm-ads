export type Campaign = {
  id: string;
  name: string;
  channel: "search" | "network";
  allocation: number;
  spent: number;
  leads: number;
  clients: number;
  clicks: number;
  impressions: number;
  status: string;
  revision: number;
  selectedVariant?: string;
};
export type Creative = {
  id: string;
  angle: string;
  title: string;
  text: string;
  status: string;
  kind: string;
  color: string;
};
export type Experiment = {
  id: string;
  name: string;
  hypothesis: string;
  factor: string;
  metric: string;
  status: string;
  elapsedDays: number;
  maxDays: number;
  minClicks: number;
  variants: { name: string; clicks: number; leads: number }[];
  verdict: string;
  winner?: number;
};
export type Change = {
  id: string;
  at: string;
  kind: string;
  title: string;
  reason: string;
  rule: string;
  rollbackOf?: string;
  before?: object;
  after?: object;
};
export type Business = {
  mode: "demo" | "live";
  name: string;
  category: string;
  city: string;
  website: string;
  landingMode?: "external" | "yandex_landing";
  service: string;
  benefit: string;
  price: number;
  budget: number;
  targetCpa: number;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  running: boolean;
  clientsTracked: boolean;
  reservePercent: number;
  lastSync: string | null;
  counterId: string;
  goalId: string;
  campaigns: Campaign[];
  creatives: Creative[];
  aiPlan?: {
    provider: "ollama" | "fallback";
    model: string;
    promptVersion: string;
    inputHash: string;
    validation: { status: "passed"; schema: string };
    corrections: string[];
    createdAt: string;
    version: string;
    plan: {
      summary: string;
      audiences: { name: string; need: string }[];
      channels: ("search" | "network")[];
      keywords: string[];
      negativeKeywords: string[];
      ads: { angle: string; title: string; text: string }[];
      budgetAllocation: { channel: "search" | "network"; percent: number }[];
      abHypotheses: { hypothesis: string; changes: string; metric: string }[];
      assumptions: string[];
      warnings: string[];
    };
  } | null;
  remoteAiPlan?: {
    status: "pending" | "ready" | "failed";
    jobId: string;
    queuedAt: string;
    finishedAt?: string;
  };
  experiments: Experiment[];
  daily: { label: string; spent: number; leads: number }[];
  sequence: number;
  shadowAnalysis?: boolean;
  analysis?: {
    provider: "rules" | "ollama";
    version: string;
    createdAt: string;
    stateVersion: number;
    executed: false;
    proposals: {
      campaignId: string;
      action: string;
      summary: string;
      evidence: {
        spent: number;
        leads: number;
        clicks: number;
        targetCpa: number;
      };
      requiresReview: true;
    }[];
  };
};
export type Workspace = {
  id: string;
  version: number;
  state: Business;
  totals: {
    spent: number;
    leads: number;
    clients: number | null;
    clicks: number;
    impressions: number;
    cpa: number | null;
    cac: number | null;
    remaining: number;
    reserve: number;
  };
  events: Change[];
  jobs: {
    id: string;
    status: string;
    attempts: number;
    availableAt: number;
    error: string | null;
  }[];
  connections: {
    provider: string;
    connectedAt: string;
    sandbox: boolean;
    model?: string;
    purpose?: string;
    validation?: "pending" | "blocked" | "verified" | "reauth_required";
    validationCode?: string | null;
    validationMessage?: string | null;
    validatedAt?: string;
    tokenRefreshedAt?: string;
    tokenExpiresAt?: string | null;
    clients: { Login: string; ClientId: number; Currency?: string }[];
  }[];
  directChanges: DirectChange[];
  abPlans: DirectAbPlan[];
  controlReviews: DirectControlReview[];
  shadowReviews: LiveShadowReview[];
  shadowReviewJobs: {
    id: string;
    changeId: string;
    status: "pending" | "running" | "succeeded" | "failed";
    attempts: number;
    availableAt: number;
    error: string | null;
  }[];
  adLifecycle: {
    status:
      | "draft"
      | "validating"
      | "ready"
      | "creating"
      | "moderation"
      | "active"
      | "paused"
      | "blocked"
      | "needs_reconciliation"
      | "completed";
    changeId: string | null;
    reason: string;
    updatedAt: string | null;
  };
  optimizerActions: {
    id: string;
    changeId: string;
    reviewId: string;
    action: "pause_campaign" | "consider_reallocation";
    status:
      | "proposed"
      | "dispatching"
      | "applied"
      | "failed_no_write"
      | "needs_reconciliation"
      | "rolled_back"
      | "rollback_needs_reconciliation";
    reason: string;
    guard: Record<string, unknown>;
    createdAt: string;
  }[];
  audienceExperiments: {
    id: string;
    changeId: string;
    hypothesis: string;
    dimension:
      | "geo_radius"
      | "search_intent"
      | "interest_group"
      | "visitor_type"
      | "need_wording";
    metric: "goal_rate_per_click";
    allocation: "50/50";
    control: { name: string; value: string };
    variant: { name: string; value: string };
    criteria: Record<string, number | string | boolean>;
    status:
      | "planned"
      | "collecting"
      | "inconclusive"
      | "control_wins"
      | "variant_wins";
    conclusion: string;
    appliedAction: "none";
    evidence?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }[];
  creativeImages: CreativeImage[];
  capabilities: {
    google: boolean;
    yandex: boolean;
    liveLaunch: boolean;
    directWritePilot: boolean;
    directArchivePilot: boolean;
    directModerationPilot: boolean;
    directResumePilot: boolean;
    directBudgetPilot: boolean;
    directAbVariantPilot: boolean;
    directAbDecisionPilot: boolean;
    abPlanning: boolean;
    analyst: boolean;
    creativeImages: boolean;
    creativeImageSetup: boolean;
    creativeImageProvider: "openai" | "local" | null;
  };
  reports: ReportSnapshot[];
  reportJobs: {
    id: string;
    status: string;
    attempts: number;
    availableAt: number;
    error: string | null;
  }[];
};
export type DirectAbPlan = {
  id: string;
  changeId: string;
  campaignId: number;
  hypothesis: string;
  metric: "ctr";
  minDays: number;
  minImpressionsPerVariant: number;
  periodStart: string;
  periodEnd: string;
  control: { adId: string; title: string; text: string; href: string };
  variant: { adId: string | null; title: string; text: string; href: string };
  allocation: string;
  outcome:
    | "unavailable"
    | "collecting"
    | "control_wins"
    | "variant_wins"
    | "inconclusive";
  verdict: string;
  evidence: {
    status: string;
    verdict: string;
    reportId: string | null;
    dateTo: string | null;
    days: number;
    allocationBalanced: boolean;
    sampleMet: boolean;
    controlShare?: number | null;
    control: {
      impressions: number;
      clicks: number;
      ctr: number | null;
      interval: [number, number] | null;
    };
    variant: {
      impressions: number;
      clicks: number;
      ctr: number | null;
      interval: [number, number] | null;
    };
  };
  blockers: string[];
  createdAt: string;
  status:
    | "planned_unpublished"
    | "variant_created_held"
    | "variant_rolled_back"
    | "outcome_applied";
  externalWrites: number;
  action: null | {
    id: string;
    status:
      | "checking"
      | "sending"
      | "succeeded"
      | "failed_no_write"
      | "not_applied"
      | "needs_reconciliation";
    variantAdId: string | null;
    writeAttempted: boolean;
    errorCode: string | null;
    updatedAt: string;
  };
  decision: null | {
    id: string;
    operation: "rollback_variant" | "apply_outcome";
    targetAdId: string;
    status:
      | "checking"
      | "sending"
      | "succeeded"
      | "failed_no_write"
      | "not_applied"
      | "needs_reconciliation";
    writeAttempted: boolean;
    errorCode: string | null;
    beforeState: string | null;
    afterState: string | null;
    updatedAt: string;
  };
};
export type LiveShadowReview = {
  id: string;
  changeId: string;
  campaignId: number;
  checkedAt: string;
  status: "observed" | "insufficient";
  blocker: string | null;
  executed: false;
  requiresReview: true;
  action: "observe" | "review_attribution" | "review_campaign_performance";
  reason: string;
  source: {
    direct: null | {
      snapshotId: string;
      dateFrom: string;
      dateTo: string;
      snapshotDateTo?: string;
      receivedAt: string;
      spentKopecks?: number;
      clicks?: number;
      impressions?: number;
    };
    metrica: null | {
      visits: number;
      goalReaches: number;
      counterId: string;
      goalId: string;
    };
    attributedMetrica: null | {
      visits: number;
      goalReaches: number;
      counterId: string;
      goalId: string;
      campaignId: number;
      attribution: "lastsign";
      filterDimension: "ym:s:lastsignDirectClickOrder";
    };
    campaign: null | { state: string; status: string };
    attribution: "site_wide_only" | "direct_campaign_last_significant";
    campaignGoalReaches: number | null;
    campaignCpaKopecks: number | null;
  };
};
export type DirectControlReview = {
  id: string;
  changeId: string;
  campaignId: number;
  checkedAt: string;
  status: "blocked" | "technical_ready";
  blockers: string[];
  budget: {
    limitKopecks: number | null;
    spentKopecks: number | null;
    reportReceivedAt: string | null;
    reportDateTo: string | null;
  };
  remote: {
    state: string;
    status: string;
    statusPayment: string | null;
    groups: number;
    ads: number;
    keywords: number;
  };
  manualChecks: string[];
  safeToResume: false;
  externalWrites: 0;
};
export type CreativeImage = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  prompt: string;
  style: "editorial" | "local" | "detail";
  goal: "leads" | "trust" | "offer";
  hook: "outcome" | "human" | "perspective";
  format: "standard" | "square" | "wide" | "vertical";
  audience: string;
  companyName: string;
  brandPlacement: "none" | "bottom-left" | "bottom-right";
  seed: number;
  provider: string;
  model: string;
  mimeType: "image/jpeg" | "image/png" | null;
  byteSize: number | null;
  sha256: string | null;
  approvedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  ratio: string | null;
};
export type DirectCommand = {
  key: string;
  service: "campaigns" | "adgroups" | "ads" | "keywords";
  method: "add" | "suspend";
  dependsOn?: string[];
  params: Record<string, unknown>;
  fingerprint: string;
};
export type DirectPlan = {
  login: string;
  campaignName: string;
  website: string;
  audience: string;
  regionIds: number[];
  budget: number;
  targetCpa: number;
  periodStart: string;
  periodEnd: string;
  counterId?: string;
  goalId?: string;
  ads: { title: string; title2?: string; text: string; href: string }[];
  keywords: string[];
  negativeKeywords?: string[];
};
export type DirectChange = {
  id: string;
  mode: "dry_run";
  status: string;
  attempts: number;
  availableAt: number;
  plan?: DirectPlan;
  commands: DirectCommand[];
  summary: {
    campaigns: number;
    adGroups: number;
    ads: number;
    keywords: number;
    externalCalls: number;
  };
  reconciliation: null | {
    status: string;
    expectedCommands: number;
    preparedCommands: number;
    externalCalls: number;
    checkedAt: string;
  };
  error: string | null;
  createdAt?: string;
  updatedAt?: string;
  preflight?: DirectPreflight | null;
  approval?: DirectApproval | null;
  execution?: {
    status: "running" | "needs_reconciliation" | "succeeded";
    inflightKey: string | null;
    suspendVerified: boolean;
    calls: { key: string; ids: (number | string)[] }[];
    errorCode: string | null;
    updatedAt: string;
    reconciliation?: {
      status: "matched" | "mismatch" | "incomplete";
      checkedAt: string;
      unresolvedStep: string | null;
    } | null;
  } | null;
  lifecycle?: {
    id: string;
    campaignId: number;
    status:
      | "checking"
      | "sending"
      | "needs_reconciliation"
      | "succeeded"
      | "failed_no_write";
    beforeState: string | null;
    afterState: string | null;
    writeAttempted: number;
    errorCode: string | null;
    updatedAt: string;
  } | null;
  budgetCheck?: {
    id: string;
    checkedAt: string;
    status: "matched" | "drift";
    findings: string[];
    plan: { budgetKopecks: number; periodStart: string; periodEnd: string };
    remote: {
      state: string;
      limitKopecks: number | null;
      periodStart: string | null;
      periodEnd: string | null;
      autoContinue: string | null;
    };
    report: {
      snapshotId: string;
      dateFrom: string;
      dateTo: string;
      receivedAt: string;
      includeVat: boolean;
      reportedSpentKopecks: number;
      coversPeriodToDate: boolean;
    } | null;
    safeToResumeOrChangeLimit: false;
  } | null;
};
export type DirectApproval = {
  status: "confirmed";
  changeId: string;
  planFingerprint: string;
  confirmedAt: string;
  expiresAt: string;
  externalWrites: 0;
};
export type DirectPreflight = {
  schema: string;
  changeId: string;
  planFingerprint: string;
  checkedAt: string;
  connectionId: string | null;
  ready: boolean;
  findings: {
    severity: "blocker" | "warning";
    code: string;
    message: string;
  }[];
  account: { login: string; currency: string; clientId: number } | null;
  plan: {
    campaignName: string;
    startDate: string;
    endDate: string;
    budget: number;
    regionIds: number[];
    ads: number;
    keywords: number;
  };
  remote: { campaignCount: number; readCalls: number; writeCalls: 0 };
};
export type ReportSnapshot = {
  id: string;
  empty: boolean;
  metrica: null | {
    status: "ready" | "unavailable";
    counterId: string;
    goalId: string;
    dateFrom: string;
    dateTo: string;
    visits?: number;
    goalReaches?: number;
    sampled?: boolean;
  };
  reportType: "campaign" | "ad";
  requestedAdIds: string[];
  abPlanId: string | null;
  source: "demo" | "yandex-sandbox" | "yandex";
  login: string;
  dateFrom: string;
  dateTo: string;
  currency: string;
  includeVat: boolean;
  receivedAt: string;
  rawHash: string;
  previousId: string | null;
  totals: {
    spent: number;
    clicks: number;
    impressions: number;
    conversions: number;
    rowCount: number;
  };
  comparison: {
    status: "first" | "changed" | "unchanged";
    deltaSpent: number;
    changedRows: number;
    missingRows: number;
    addedRows: number;
    conservativeSpent: number;
  };
  rows: {
    Date: string;
    CampaignId: string;
    CampaignName?: string;
    AdGroupId?: string;
    AdId?: string;
    spent: number;
    clicks: number;
    impressions: number;
    conversions: number;
  }[];
};
export type Session = {
  user: { id: string; name: string; demo: boolean } | null;
  demoAvailable: boolean;
  googleConfigured: boolean;
  yandexConfigured: boolean;
  liveLaunch: boolean;
};
