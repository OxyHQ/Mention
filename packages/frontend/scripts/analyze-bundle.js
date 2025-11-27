#!/usr/bin/env node

/**
 * Bundle Analysis Script
 * Analyzes bundle size and provides insights for optimization
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const METRO_CONFIG = path.join(PROJECT_ROOT, 'metro.config.js');

console.log('📦 Bundle Analysis Tool');
console.log('======================\n');

/**
 * Analyze bundle files
 */
function analyzeBundle() {
  if (!fs.existsSync(DIST_DIR)) {
    console.log('❌ Dist directory not found. Building bundle first...\n');
    try {
      execSync('npm run build-web', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } catch (error) {
      console.error('❌ Build failed:', error.message);
      process.exit(1);
    }
  }

  const files = getAllFiles(DIST_DIR);
  const analysis = {
    totalSize: 0,
    files: [],
    byExtension: {},
    largestFiles: [],
  };

  files.forEach((file) => {
    const stats = fs.statSync(file);
    const size = stats.size;
    const ext = path.extname(file);
    const relativePath = path.relative(DIST_DIR, file);

    analysis.totalSize += size;
    analysis.files.push({
      path: relativePath,
      size,
      ext,
    });

    if (!analysis.byExtension[ext]) {
      analysis.byExtension[ext] = { count: 0, totalSize: 0 };
    }
    analysis.byExtension[ext].count++;
    analysis.byExtension[ext].totalSize += size;
  });

  // Sort files by size
  analysis.files.sort((a, b) => b.size - a.size);
  analysis.largestFiles = analysis.files.slice(0, 10);

  return analysis;
}

/**
 * Get all files recursively
 */
function getAllFiles(dir) {
  const files = [];
  const items = fs.readdirSync(dir);

  items.forEach((item) => {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  });

  return files;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Print analysis results
 */
function printAnalysis(analysis) {
  console.log('📊 Bundle Analysis Results');
  console.log('==========================\n');

  console.log(`Total Bundle Size: ${formatBytes(analysis.totalSize)}\n`);

  console.log('📁 Size by Extension:');
  Object.entries(analysis.byExtension)
    .sort(([, a], [, b]) => b.totalSize - a.totalSize)
    .forEach(([ext, data]) => {
      const percentage = ((data.totalSize / analysis.totalSize) * 100).toFixed(1);
      console.log(`  ${ext || '(no extension)'}: ${formatBytes(data.totalSize)} (${data.count} files, ${percentage}%)`);
    });

  console.log('\n🔝 Top 10 Largest Files:');
  analysis.largestFiles.forEach((file, index) => {
    const percentage = ((file.size / analysis.totalSize) * 100).toFixed(1);
    console.log(`  ${index + 1}. ${file.path}: ${formatBytes(file.size)} (${percentage}%)`);
  });

  console.log('\n💡 Optimization Recommendations:');
  console.log('  - Check largest files for unnecessary code');
  console.log('  - Consider code splitting for large modules');
  console.log('  - Optimize images and assets');
  console.log('  - Review dependencies for tree-shaking');
  console.log('');
}

/**
 * Check Metro config for optimization
 */
function checkMetroConfig() {
  console.log('⚙️  Metro Config Check:');
  console.log('======================\n');

  if (!fs.existsSync(METRO_CONFIG)) {
    console.log('❌ metro.config.js not found\n');
    return;
  }

  const configContent = fs.readFileSync(METRO_CONFIG, 'utf8');
  const checks = [
    {
      name: 'Tree shaking enabled',
      check: configContent.includes('minify') || configContent.includes('transform'),
      recommendation: 'Enable minification and tree shaking in Metro config',
    },
    {
      name: 'Watch folders optimized',
      check: configContent.includes('watchFolders'),
      recommendation: 'Configure watchFolders to exclude unnecessary directories',
    },
    {
      name: 'Block list configured',
      check: configContent.includes('blockList'),
      recommendation: 'Add blockList to exclude test files and unnecessary code',
    },
  ];

  checks.forEach(({ name, check, recommendation }) => {
    const icon = check ? '✅' : '⚠️';
    console.log(`  ${icon} ${name}`);
    if (!check) {
      console.log(`     → ${recommendation}`);
    }
  });
  console.log('');
}

// Run analysis
try {
  const analysis = analyzeBundle();
  printAnalysis(analysis);
  checkMetroConfig();
} catch (error) {
  console.error('❌ Analysis failed:', error.message);
  process.exit(1);
}

