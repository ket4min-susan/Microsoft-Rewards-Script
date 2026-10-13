module.exports = {
  apps: [
    {
      name: 'bing-reward-scheduler',
      script: './dist/scheduler.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Ho_Chi_Minh',
        SCHEDULE_HOUR: '9',
        SCHEDULE_MINUTE: '0',
        SCHEDULE_JITTER_MINUTES: '15',
        FORCE_HEADLESS: '1'
      }
    }
  ]
};
