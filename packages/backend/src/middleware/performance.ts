import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

interface PerformanceMetrics {
  responseTime: number;
  method: string;
  path: string;
  statusCode: number;
  timestamp: number;
}

// In-memory metrics storage (can be moved to Redis for distributed systems)
const metrics: PerformanceMetrics[] = [];
const MAX_METRICS = 1000; // Keep last 1000 requests

/**
 * Performance monitoring middleware
 * Tracks response times, status codes, and request patterns
 */
export function performanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const path = req.path;
  const method = req.method;

  // Override res.end to capture response time
  const originalEnd = res.end;
  res.end = function(chunk?: any, encoding?: any) {
    const responseTime = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Log slow requests (> 1 second)
    if (responseTime > 1000) {
      logger.warn(`Slow request detected: ${method} ${path} took ${responseTime}ms`, {
        method,
        path,
        responseTime,
        statusCode,
      });
    }

    // Store metric
    const metric: PerformanceMetrics = {
      responseTime,
      method,
      path,
      statusCode,
      timestamp: Date.now(),
    };

    metrics.push(metric);

    // Keep only last MAX_METRICS
    if (metrics.length > MAX_METRICS) {
      metrics.shift();
    }

    // Call original end
    originalEnd.call(this, chunk, encoding);
  };

  next();
}

/**
 * Get performance statistics
 */
export function getPerformanceStats() {
  if (metrics.length === 0) {
    return {
      totalRequests: 0,
      averageResponseTime: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      slowRequests: 0,
      errorRate: 0,
    };
  }

  const responseTimes = metrics.map(m => m.responseTime).sort((a, b) => a - b);
  const totalRequests = metrics.length;
  const averageResponseTime = responseTimes.reduce((a, b) => a + b, 0) / totalRequests;
  const p50 = responseTimes[Math.floor(totalRequests * 0.5)];
  const p95 = responseTimes[Math.floor(totalRequests * 0.95)];
  const p99 = responseTimes[Math.floor(totalRequests * 0.99)];
  const slowRequests = metrics.filter(m => m.responseTime > 1000).length;
  const errorRequests = metrics.filter(m => m.statusCode >= 400).length;
  const errorRate = (errorRequests / totalRequests) * 100;

  return {
    totalRequests,
    averageResponseTime: Math.round(averageResponseTime),
    p50,
    p95,
    p99,
    slowRequests,
    errorRate: Math.round(errorRate * 100) / 100,
  };
}

/**
 * Get metrics by endpoint
 */
export function getMetricsByEndpoint() {
  const endpointMap = new Map<string, { count: number; totalTime: number; errors: number }>();

  metrics.forEach(metric => {
    const key = `${metric.method} ${metric.path}`;
    const existing = endpointMap.get(key) || { count: 0, totalTime: 0, errors: 0 };
    existing.count++;
    existing.totalTime += metric.responseTime;
    if (metric.statusCode >= 400) {
      existing.errors++;
    }
    endpointMap.set(key, existing);
  });

  const result: Array<{
    endpoint: string;
    count: number;
    averageTime: number;
    errorRate: number;
  }> = [];

  endpointMap.forEach((stats, endpoint) => {
    result.push({
      endpoint,
      count: stats.count,
      averageTime: Math.round(stats.totalTime / stats.count),
      errorRate: Math.round((stats.errors / stats.count) * 100 * 100) / 100,
    });
  });

  return result.sort((a, b) => b.count - a.count);
}

/**
 * Clear metrics (useful for testing or periodic cleanup)
 */
export function clearMetrics(): void {
  metrics.length = 0;
}

