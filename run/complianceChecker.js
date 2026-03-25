// ============================================================
// MODULE: complianceChecker.js
// PURPOSE: Platform policy validation — prevent bans, flag violations
// PHASE: 5
// STATUS: ACTIVE
// CHECKS: Copyright, community guidelines, spam patterns, disclosure rules
// ============================================================

const { createLogger } = require('./logger');

const log = createLogger('ComplianceChecker');

// ─── POLICY RULES ───────────────────────────────────────────

const POLICY_RULES = {
  youtube: {
    maxPostsPerDay: 50,
    minIntervalMinutes: 15,
    bannedWords: ['guaranteed returns', 'get rich quick', 'free money', 'mlm', 'pyramid'],
    requiredDisclosures: ['not financial advice', 'nfa'],
    maxHashtags: 15,
    maxTitleLength: 100,
    maxDescriptionLength: 5000,
    copyrightKeywords: ['royalty free', 'licensed'],
  },
  instagram: {
    maxPostsPerDay: 25,
    minIntervalMinutes: 30,
    bannedWords: ['guaranteed returns', 'dm for info', 'link in bio scam'],
    requiredDisclosures: [],
    maxHashtags: 30,
    maxCaptionLength: 2200,
  },
  tiktok: {
    maxPostsPerDay: 30,
    minIntervalMinutes: 20,
    bannedWords: ['guaranteed', 'get rich', 'scam', 'pyramid'],
    requiredDisclosures: [],
    maxHashtags: 5,
    maxCaptionLength: 4000,
  },
};

const ViolationType = {
  BANNED_WORD: 'banned_word',
  SPAM_PATTERN: 'spam_pattern',
  RATE_LIMIT: 'rate_limit',
  MISSING_DISCLOSURE: 'missing_disclosure',
  CONTENT_LENGTH: 'content_length',
  HASHTAG_LIMIT: 'hashtag_limit',
  COPYRIGHT_RISK: 'copyright_risk',
};

const Severity = {
  CRITICAL: 'critical',   // Will definitely cause ban/removal
  WARNING: 'warning',     // Risky, should fix
  INFO: 'info',           // Best practice suggestion
};

// ─── COMPLIANCE CHECKER ─────────────────────────────────────

class ComplianceChecker {
  constructor() {
    this.postHistory = {};    // platform -> [{ timestamp }]
    this.violations = [];
    this.checksPerformed = 0;
  }

  // ─── CHECK CONTENT BEFORE PUBLISH ───────────────────────

  check(platform, content) {
    const rules = POLICY_RULES[platform];
    if (!rules) return { passed: true, violations: [], warnings: [] };

    const violations = [];
    const warnings = [];
    this.checksPerformed++;

    const text = (content.title || '') + ' ' + (content.caption || '') + ' ' + (content.description || '');
    const textLower = text.toLowerCase();

    // 1. Banned words
    for (const word of rules.bannedWords) {
      if (textLower.includes(word)) {
        violations.push({
          type: ViolationType.BANNED_WORD,
          severity: Severity.CRITICAL,
          message: `Contains banned phrase: "${word}"`,
          platform,
          fix: `Remove or rephrase "${word}"`,
        });
      }
    }

    // 2. Required disclosures (finance niche)
    if (rules.requiredDisclosures.length > 0) {
      const hasDisclosure = rules.requiredDisclosures.some(d => textLower.includes(d));
      if (!hasDisclosure) {
        warnings.push({
          type: ViolationType.MISSING_DISCLOSURE,
          severity: Severity.WARNING,
          message: `Missing financial disclaimer (e.g., "Not financial advice")`,
          platform,
          fix: `Add "This is not financial advice" to description`,
        });
      }
    }

    // 3. Spam pattern detection
    const exclamationCount = (text.match(/!/g) || []).length;
    const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);
    if (exclamationCount > 5) {
      warnings.push({
        type: ViolationType.SPAM_PATTERN,
        severity: Severity.WARNING,
        message: `Excessive exclamation marks (${exclamationCount}) — may trigger spam filter`,
        platform,
        fix: 'Reduce to 1-2 exclamation marks',
      });
    }
    if (capsRatio > 0.5 && text.length > 20) {
      warnings.push({
        type: ViolationType.SPAM_PATTERN,
        severity: Severity.WARNING,
        message: `Too many capital letters (${Math.round(capsRatio * 100)}%) — spam signal`,
        platform,
        fix: 'Use normal capitalization',
      });
    }

    // 4. Content length
    const captionLen = (content.caption || content.description || '').length;
    const maxLen = rules.maxCaptionLength || rules.maxDescriptionLength || 5000;
    if (captionLen > maxLen) {
      violations.push({
        type: ViolationType.CONTENT_LENGTH,
        severity: Severity.CRITICAL,
        message: `Caption too long: ${captionLen}/${maxLen} chars`,
        platform,
        fix: `Shorten to ${maxLen} characters`,
      });
    }

    // 5. Hashtag limit
    const hashtags = (text.match(/#\w+/g) || []).length;
    if (hashtags > rules.maxHashtags) {
      warnings.push({
        type: ViolationType.HASHTAG_LIMIT,
        severity: Severity.WARNING,
        message: `Too many hashtags: ${hashtags}/${rules.maxHashtags}`,
        platform,
        fix: `Reduce to ${rules.maxHashtags} hashtags`,
      });
    }

    // 6. Rate limit check
    if (!this.postHistory[platform]) this.postHistory[platform] = [];
    const now = Date.now();
    const recentPosts = this.postHistory[platform].filter(t => t > now - 86400000);
    if (recentPosts.length >= rules.maxPostsPerDay) {
      violations.push({
        type: ViolationType.RATE_LIMIT,
        severity: Severity.CRITICAL,
        message: `Daily post limit reached: ${recentPosts.length}/${rules.maxPostsPerDay}`,
        platform,
        fix: `Wait until tomorrow or reduce frequency`,
      });
    }

    const lastPost = recentPosts.length > 0 ? recentPosts[recentPosts.length - 1] : 0;
    const minutesSince = (now - lastPost) / 60000;
    if (lastPost > 0 && minutesSince < rules.minIntervalMinutes) {
      warnings.push({
        type: ViolationType.RATE_LIMIT,
        severity: Severity.WARNING,
        message: `Too frequent: ${Math.round(minutesSince)}min since last post (min: ${rules.minIntervalMinutes}min)`,
        platform,
        fix: `Wait ${Math.ceil(rules.minIntervalMinutes - minutesSince)} more minutes`,
      });
    }

    // Store violations
    this.violations.push(...violations, ...warnings);

    const passed = violations.length === 0;

    log.info('Compliance check', {
      platform,
      passed,
      violations: violations.length,
      warnings: warnings.length,
    });

    return { passed, violations, warnings };
  }

  // Record that we published (for rate limit tracking)
  recordPublish(platform) {
    if (!this.postHistory[platform]) this.postHistory[platform] = [];
    this.postHistory[platform].push(Date.now());
  }

  // Auto-fix content
  autoFix(platform, content) {
    const rules = POLICY_RULES[platform];
    if (!rules) return content;

    const fixed = { ...content };
    let changes = [];

    // Strip banned words
    let text = fixed.caption || fixed.description || '';
    for (const word of rules.bannedWords) {
      if (text.toLowerCase().includes(word)) {
        text = text.replace(new RegExp(word, 'gi'), '***');
        changes.push(`Replaced "${word}"`);
      }
    }

    // Add disclosure
    if (rules.requiredDisclosures.length > 0 && !rules.requiredDisclosures.some(d => text.toLowerCase().includes(d))) {
      text += '\n\nDisclaimer: This is not financial advice.';
      changes.push('Added financial disclaimer');
    }

    // Truncate if too long
    const maxLen = rules.maxCaptionLength || rules.maxDescriptionLength || 5000;
    if (text.length > maxLen) {
      text = text.substring(0, maxLen - 3) + '...';
      changes.push(`Truncated to ${maxLen} chars`);
    }

    if (fixed.caption) fixed.caption = text;
    if (fixed.description) fixed.description = text;

    return { content: fixed, changes };
  }

  getStats() {
    return {
      checksPerformed: this.checksPerformed,
      totalViolations: this.violations.length,
      bySeverity: this.violations.reduce((acc, v) => { acc[v.severity] = (acc[v.severity] || 0) + 1; return acc; }, {}),
      byType: this.violations.reduce((acc, v) => { acc[v.type] = (acc[v.type] || 0) + 1; return acc; }, {}),
    };
  }

  clean() {
    this.postHistory = {};
    this.violations = [];
    this.checksPerformed = 0;
    log.info('ComplianceChecker cleaned');
  }
}

const complianceChecker = new ComplianceChecker();

module.exports = { ComplianceChecker, complianceChecker, POLICY_RULES, ViolationType, Severity };
