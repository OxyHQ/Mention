#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname.replace('/scripts', '');

console.log('🧹 Cleaning Metro and Expo caches...');

// Remove cache directories
const cacheDirs = [
  path.join(projectRoot, '.expo'),
  path.join(projectRoot, '.expo-shared'),
  path.join(projectRoot, '.metro'),
  path.join(projectRoot, '.cache'),
  path.join(projectRoot, 'node_modules/.cache'),
  path.join(projectRoot, 'dist'),
];

cacheDirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    console.log(`  Removing ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Clear Watchman
try {
  console.log('  Clearing Watchman...');
  execSync('watchman watch-del-all', { stdio: 'ignore' });
} catch (e) {
  console.log('  Watchman not available or already cleared');
}

// Clear npm cache for this project
try {
  console.log('  Clearing npm cache...');
  execSync('npm cache clean --force', { stdio: 'ignore', cwd: projectRoot });
} catch (e) {
  console.log('  npm cache clear failed (non-critical)');
}

console.log('✅ Cache cleared!');
console.log('💡 Now run: npm run start');
