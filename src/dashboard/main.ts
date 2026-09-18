import './styles/global.css';
import './components/yoke-app.js';
import { DashboardStore } from './store/dashboard-store.js';

const store = new DashboardStore();
await store.bootstrap();
store.connectLive();

const app = document.createElement('yoke-app') as HTMLElement & { store: DashboardStore };
(app as unknown as Record<string, unknown>)['store'] = store;
document.body.appendChild(app);
