import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ base: '/live2d-automation-workbench/', plugins: [react()], build: { outDir: 'docs', emptyOutDir: true } });
