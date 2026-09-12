import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Asset-Pfade statt absoluter.
  // GitHub Pages liefert ein Projekt-Repo unter /<repo-name>/ aus; mit dem
  // Vite-Standard "/" würden die Assets auf die Domain-Wurzel zeigen und 404en.
  // './' funktioniert in jedem Unterverzeichnis und auch lokal aus dist/.
  base: './',
  server: {
    port: 5173,
    // `npm run dev:lan` bindet zusätzlich auf das LAN-Interface.
    // Achtung: Mikrofonzugriff braucht dann HTTPS – siehe README.
  },
  build: {
    target: 'es2020',
  },
});
