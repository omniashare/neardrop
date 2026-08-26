/** Managed by setup-reppit-workflow.sh (RePPIT) */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
  },
});
