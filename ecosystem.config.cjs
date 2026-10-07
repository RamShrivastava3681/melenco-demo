module.exports = {
  apps: [
    {
      name: "ledgerly-backend",
      cwd: "./backend",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3004",
        // REQUIRED: generate with `openssl rand -hex 32` and paste here.
        // The backend refuses to boot in production without a real secret
        // (empty/default silently invalidates every connector token).
        JWT_SECRET: "REPLACE_WITH_STRONG_RANDOM_SECRET", // ← Set this to a strong random value!
        AWS_REGION: "ap-south-1",
        AWS_ACCESS_KEY_ID: "", // ← IAM credentials with DynamoDB access to the table below
        AWS_SECRET_ACCESS_KEY: "", // ← (or omit both when running on infra with an instance role)
        DYNAMODB_TABLE_PREFIX: "mickey-mouse", // ← DynamoDB single-table name (pk + sk)
        ADMIN_EMAIL: "", // ← Set to seed an admin user on first boot (e.g. "admin@example.com")
        ADMIN_PASSWORD: "", // ← Set alongside ADMIN_EMAIL (min 6 chars)
        FRONTEND_URL: "https://excel.frillchills.com",
        PUBLIC_API_BASE_URL: "https://excel.frillchills.com/api",
        XERO_REDIRECT_URI: "https://excel.frillchills.com/api/xero/callback",
      },
      error_file: "../logs/backend-error.log",
      out_file: "../logs/backend-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
    },
  ],
};
