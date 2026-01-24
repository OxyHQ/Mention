const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const APK_PATH = path.join(__dirname, 'outputs', 'mention-latest.apk');
const BUILD_INFO_PATH = path.join(__dirname, 'outputs', 'build-info.json');

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Root endpoint - API info
app.get('/', (req, res) => {
  res.json({
    service: 'Mention APK Builder',
    version: '1.0.0',
    endpoints: {
      '/android-latest-apk': 'Download latest Android APK',
      '/build-info': 'Get build metadata',
      '/health': 'Health check'
    },
    documentation: 'https://github.com/mention/mention'
  });
});

// Serve latest APK
app.get('/android-latest-apk', (req, res) => {
  console.log('APK download requested');

  // Check if APK exists
  if (!fs.existsSync(APK_PATH)) {
    console.error('APK not found at:', APK_PATH);
    return res.status(404).json({
      error: 'APK not available',
      message: 'The APK has not been built yet. Please check build logs.',
      path: APK_PATH
    });
  }

  // Get APK file stats
  const stats = fs.statSync(APK_PATH);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`Serving APK: ${fileSizeMB}MB`);

  // Set appropriate headers for APK download
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="mention-latest.apk"');
  res.setHeader('Content-Length', stats.size);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Stream the file
  const fileStream = fs.createReadStream(APK_PATH);

  fileStream.on('error', (error) => {
    console.error('Error streaming APK:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error streaming APK file' });
    }
  });

  fileStream.on('end', () => {
    console.log('APK download completed');
  });

  fileStream.pipe(res);
});

// Build information endpoint
app.get('/build-info', (req, res) => {
  console.log('Build info requested');

  // Check if build info exists
  if (!fs.existsSync(BUILD_INFO_PATH)) {
    return res.status(404).json({
      error: 'Build info not available',
      message: 'Build metadata not found. The APK may not have been built yet.'
    });
  }

  try {
    // Read and parse build info
    const buildInfo = JSON.parse(fs.readFileSync(BUILD_INFO_PATH, 'utf8'));

    // Add APK availability status
    buildInfo.apkAvailable = fs.existsSync(APK_PATH);
    buildInfo.downloadUrl = '/android-latest-apk';

    res.json(buildInfo);
  } catch (error) {
    console.error('Error reading build info:', error);
    res.status(500).json({
      error: 'Error reading build information',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const apkExists = fs.existsSync(APK_PATH);
  const buildInfoExists = fs.existsSync(BUILD_INFO_PATH);

  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    apk: {
      exists: apkExists,
      path: APK_PATH
    },
    buildInfo: {
      exists: buildInfoExists,
      path: BUILD_INFO_PATH
    },
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      unit: 'MB'
    }
  };

  // Add build info if available
  if (buildInfoExists) {
    try {
      const buildInfo = JSON.parse(fs.readFileSync(BUILD_INFO_PATH, 'utf8'));
      health.build = {
        version: buildInfo.version,
        date: buildInfo.buildDate,
        type: buildInfo.buildType
      };
    } catch (error) {
      health.build = { error: 'Unable to read build info' };
    }
  }

  // Respond with 200 OK if healthy
  const statusCode = apkExists ? 200 : 503;
  res.status(statusCode).json(health);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    availableEndpoints: [
      '/android-latest-apk',
      '/build-info',
      '/health'
    ]
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('Mention APK Builder Server');
  console.log('========================================');
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  - http://localhost:${PORT}/android-latest-apk`);
  console.log(`  - http://localhost:${PORT}/build-info`);
  console.log(`  - http://localhost:${PORT}/health`);
  console.log('');
  console.log('APK Status:');
  console.log(`  - APK exists: ${fs.existsSync(APK_PATH)}`);
  console.log(`  - Build info exists: ${fs.existsSync(BUILD_INFO_PATH)}`);
  console.log('========================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
