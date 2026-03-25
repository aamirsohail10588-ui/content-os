// ============================================================
// MODULE: adminDashboard.js
// PURPOSE: Unified control panel — aggregate all module stats, system health
// PHASE: 5
// STATUS: ACTIVE
// NOTE: In-memory dashboard. Production: REST API + React frontend.
// PROVIDES: Single-pane view of entire Content OS system
// ============================================================

const { createLogger } = require('./logger');

const log = createLogger('AdminDashboard');

// ─── SYSTEM HEALTH ──────────────────────────────────────────

const SystemHealth = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
  OFFLINE: 'offline',
};

// ─── ADMIN DASHBOARD ────────────────────────────────────────

class AdminDashboard {
  constructor() {
    this.modules = new Map();   // moduleName -> { getStats(), status }
    this.alerts = [];
    this.auditLog = [];
    this.startedAt = new Date().toISOString();
  }

  // ─── REGISTER MODULE ────────────────────────────────────

  registerModule(name, module) {
    this.modules.set(name, {
      name,
      module,
      status: 'active',
      registeredAt: new Date().toISOString(),
    });
    log.info('Module registered', { name });
  }

  // ─── SYSTEM OVERVIEW ────────────────────────────────────

  getOverview() {
    const moduleStats = {};
    const moduleStatuses = {};

    for (const [name, entry] of this.modules) {
      try {
        if (typeof entry.module.getStats === 'function') {
          moduleStats[name] = entry.module.getStats();
        }
        moduleStatuses[name] = entry.status;
      } catch (err) {
        moduleStatuses[name] = 'error';
        moduleStats[name] = { error: err.message };
      }
    }

    // Compute system health
    const errorModules = Object.values(moduleStatuses).filter(s => s === 'error').length;
    let health = SystemHealth.HEALTHY;
    if (errorModules > 0) health = SystemHealth.DEGRADED;
    if (errorModules > Math.floor(this.modules.size / 2)) health = SystemHealth.CRITICAL;

    return {
      system: {
        health,
        uptime: this._getUptime(),
        startedAt: this.startedAt,
        modulesRegistered: this.modules.size,
        modulesActive: Object.values(moduleStatuses).filter(s => s === 'active').length,
        modulesError: errorModules,
      },
      modules: moduleStats,
      moduleStatuses,
      alerts: this.alerts.slice(-10),
      timestamp: new Date().toISOString(),
    };
  }

  // ─── KEY METRICS ────────────────────────────────────────

  getKeyMetrics() {
    const overview = this.getOverview();
    const metrics = {
      totalVideos: 0,
      totalRevenue: 0,
      totalCost: 0,
      totalProfit: 0,
      avgEngagement: 0,
      activeExperiments: 0,
      queueDepth: 0,
      dlqDepth: 0,
      portfolioROI: 0,
    };

    // Extract from module stats
    if (overview.modules.monetizationTracker) {
      metrics.totalRevenue = overview.modules.monetizationTracker.totalRevenueUSD || 0;
      metrics.totalCost = overview.modules.monetizationTracker.totalCostUSD || 0;
      metrics.totalProfit = overview.modules.monetizationTracker.totalProfitUSD || 0;
      metrics.totalVideos = overview.modules.monetizationTracker.totalVideosTracked || 0;
    }
    if (overview.modules.performanceTracker) {
      metrics.avgEngagement = overview.modules.performanceTracker.avgEngagement || 0;
    }
    if (overview.modules.experimentEngine) {
      metrics.activeExperiments = overview.modules.experimentEngine.running || 0;
    }
    if (overview.modules.dlq) {
      metrics.dlqDepth = overview.modules.dlq.unresolved || 0;
    }
    if (overview.modules.portfolioEngine) {
      metrics.portfolioROI = overview.modules.portfolioEngine.portfolioROI || 0;
    }

    return metrics;
  }

  // ─── ALERTS ─────────────────────────────────────────────

  addAlert(severity, message, source) {
    const alert = {
      id: `alert_${Date.now()}`,
      severity,
      message,
      source,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    };
    this.alerts.push(alert);

    if (this.alerts.length > 100) this.alerts = this.alerts.slice(-100);

    log.warn('Alert', { severity, message, source });
    return alert;
  }

  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) alert.acknowledged = true;
  }

  getActiveAlerts() {
    return this.alerts.filter(a => !a.acknowledged);
  }

  // ─── AUDIT LOG ──────────────────────────────────────────

  logAction(action, details = {}) {
    const entry = {
      action,
      details,
      timestamp: new Date().toISOString(),
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 500) this.auditLog = this.auditLog.slice(-500);
    return entry;
  }

  getAuditLog(limit = 20) {
    return this.auditLog.slice(-limit);
  }

  // ─── SYSTEM COMMANDS ────────────────────────────────────

  cleanAll() {
    for (const [name, entry] of this.modules) {
      try {
        if (typeof entry.module.clean === 'function') {
          entry.module.clean();
        }
      } catch (err) {
        log.error('Clean failed for module', { name, error: err.message });
      }
    }
    this.logAction('system_clean', { modules: this.modules.size });
    log.info('System cleaned');
  }

  // ─── UPTIME ─────────────────────────────────────────────

  _getUptime() {
    const ms = Date.now() - new Date(this.startedAt).getTime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }

  getStats() {
    return {
      modulesRegistered: this.modules.size,
      alertCount: this.alerts.length,
      activeAlerts: this.getActiveAlerts().length,
      auditEntries: this.auditLog.length,
      uptime: this._getUptime(),
    };
  }

  clean() {
    this.modules.clear();
    this.alerts = [];
    this.auditLog = [];
    log.info('AdminDashboard cleaned');
  }
}

const adminDashboard = new AdminDashboard();

module.exports = { AdminDashboard, adminDashboard, SystemHealth };
