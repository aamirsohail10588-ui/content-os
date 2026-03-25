// ============================================================
// MODULE: modules/adminDashboard.ts
// PURPOSE: Unified control panel — aggregate all module stats, system health
// PHASE: 5
// STATUS: ACTIVE
// NOTE: In-memory dashboard. Production: REST API + React frontend.
// PROVIDES: Single-pane view of entire Content OS system
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('AdminDashboard');

// ─── ENUMS ──────────────────────────────────────────────────

export enum SystemHealth {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  CRITICAL = 'critical',
  OFFLINE = 'offline',
}

// ─── INTERFACES ─────────────────────────────────────────────

export interface Cleanable {
  clean(): void;
}

export interface StatsProvider {
  getStats(): Record<string, unknown>;
}

export type RegisterableModule = Partial<Cleanable & StatsProvider>;

export interface ModuleEntry {
  name: string;
  module: RegisterableModule;
  status: 'active' | 'error' | 'disabled';
  registeredAt: string;
}

export interface Alert {
  id: string;
  severity: string;
  message: string;
  source: string;
  timestamp: string;
  acknowledged: boolean;
}

export interface AuditEntry {
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface SystemInfo {
  health: SystemHealth;
  uptime: string;
  startedAt: string;
  modulesRegistered: number;
  modulesActive: number;
  modulesError: number;
}

export interface SystemOverview {
  system: SystemInfo;
  modules: Record<string, Record<string, unknown>>;
  moduleStatuses: Record<string, string>;
  alerts: Alert[];
  timestamp: string;
}

export interface KeyMetrics {
  totalVideos: number;
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  avgEngagement: number;
  activeExperiments: number;
  queueDepth: number;
  dlqDepth: number;
  portfolioROI: number;
}

export interface DashboardStats {
  modulesRegistered: number;
  alertCount: number;
  activeAlerts: number;
  auditEntries: number;
  uptime: string;
}

// ─── ADMIN DASHBOARD CLASS ──────────────────────────────────

export class AdminDashboard {
  private modules: Map<string, ModuleEntry>;
  private alerts: Alert[];
  private auditLog: AuditEntry[];
  private startedAt: string;

  constructor() {
    this.modules = new Map();
    this.alerts = [];
    this.auditLog = [];
    this.startedAt = new Date().toISOString();
  }

  registerModule(name: string, module: RegisterableModule): void {
    this.modules.set(name, {
      name,
      module,
      status: 'active',
      registeredAt: new Date().toISOString(),
    });
    log.info('Module registered', { name });
  }

  getOverview(): SystemOverview {
    const moduleStats: Record<string, Record<string, unknown>> = {};
    const moduleStatuses: Record<string, string> = {};

    for (const [name, entry] of this.modules) {
      try {
        if (typeof entry.module.getStats === 'function') {
          moduleStats[name] = entry.module.getStats();
        }
        moduleStatuses[name] = entry.status;
      } catch (err) {
        moduleStatuses[name] = 'error';
        const message: string = err instanceof Error ? err.message : String(err);
        moduleStats[name] = { error: message };
      }
    }

    const errorModules: number = Object.values(moduleStatuses).filter(
      (s: string) => s === 'error'
    ).length;
    let health: SystemHealth = SystemHealth.HEALTHY;
    if (errorModules > 0) health = SystemHealth.DEGRADED;
    if (errorModules > Math.floor(this.modules.size / 2)) health = SystemHealth.CRITICAL;

    return {
      system: {
        health,
        uptime: this._getUptime(),
        startedAt: this.startedAt,
        modulesRegistered: this.modules.size,
        modulesActive: Object.values(moduleStatuses).filter((s: string) => s === 'active').length,
        modulesError: errorModules,
      },
      modules: moduleStats,
      moduleStatuses,
      alerts: this.alerts.slice(-10),
      timestamp: new Date().toISOString(),
    };
  }

  getKeyMetrics(): KeyMetrics {
    const overview: SystemOverview = this.getOverview();
    const metrics: KeyMetrics = {
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

    const mod = overview.modules;

    if (mod.monetizationTracker) {
      metrics.totalRevenue = (mod.monetizationTracker.totalRevenueUSD as number) || 0;
      metrics.totalCost = (mod.monetizationTracker.totalCostUSD as number) || 0;
      metrics.totalProfit = (mod.monetizationTracker.totalProfitUSD as number) || 0;
      metrics.totalVideos = (mod.monetizationTracker.totalVideosTracked as number) || 0;
    }
    if (mod.performanceTracker) {
      metrics.avgEngagement = (mod.performanceTracker.avgEngagement as number) || 0;
    }
    if (mod.experimentEngine) {
      metrics.activeExperiments = (mod.experimentEngine.running as number) || 0;
    }
    if (mod.dlq) {
      metrics.dlqDepth = (mod.dlq.unresolved as number) || 0;
    }
    if (mod.portfolioEngine) {
      metrics.portfolioROI = (mod.portfolioEngine.portfolioROI as number) || 0;
    }

    return metrics;
  }

  addAlert(severity: string, message: string, source: string): Alert {
    const alert: Alert = {
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

  acknowledgeAlert(alertId: string): void {
    const alert: Alert | undefined = this.alerts.find((a: Alert) => a.id === alertId);
    if (alert) alert.acknowledged = true;
  }

  getActiveAlerts(): Alert[] {
    return this.alerts.filter((a: Alert) => !a.acknowledged);
  }

  logAction(action: string, details: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = {
      action,
      details,
      timestamp: new Date().toISOString(),
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 500) this.auditLog = this.auditLog.slice(-500);
    return entry;
  }

  getAuditLog(limit: number = 20): AuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  cleanAll(): void {
    for (const [name, entry] of this.modules) {
      try {
        if (typeof entry.module.clean === 'function') {
          entry.module.clean();
        }
      } catch (err) {
        const message: string = err instanceof Error ? err.message : String(err);
        log.error('Clean failed for module', { name, error: message });
      }
    }
    this.logAction('system_clean', { modules: this.modules.size });
    log.info('System cleaned');
  }

  private _getUptime(): string {
    const ms: number = Date.now() - new Date(this.startedAt).getTime();
    const seconds: number = Math.floor(ms / 1000);
    const minutes: number = Math.floor(seconds / 60);
    const hours: number = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }

  getStats(): DashboardStats {
    return {
      modulesRegistered: this.modules.size,
      alertCount: this.alerts.length,
      activeAlerts: this.getActiveAlerts().length,
      auditEntries: this.auditLog.length,
      uptime: this._getUptime(),
    };
  }

  clean(): void {
    this.modules.clear();
    this.alerts = [];
    this.auditLog = [];
    log.info('AdminDashboard cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const adminDashboard: AdminDashboard = new AdminDashboard();
