import {
	createRootRoute,
	createRoute,
	createRouter,
	redirect,
} from '@tanstack/react-router';
import { App } from './App.tsx';
import { AliasesPage } from './pages/AliasesPage.tsx';
import { ConsoleIndexPage } from './pages/ConsoleIndexPage.tsx';
import { ConsoleLayout } from './pages/ConsoleLayout.tsx';
import { JobDetailPage } from './pages/JobDetailPage.tsx';
import { SettingsLayout } from './pages/SettingsLayout.tsx';
import { TimeoutSettingsPage } from './pages/TimeoutSettingsPage.tsx';

const rootRoute = createRootRoute({ component: App });

const consoleLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: 'console',
	component: ConsoleLayout,
});

const consoleIndexRoute = createRoute({
	getParentRoute: () => consoleLayoutRoute,
	path: '/',
	component: ConsoleIndexPage,
});

const jobDetailRoute = createRoute({
	getParentRoute: () => consoleLayoutRoute,
	path: 'jobs/$jobId',
	component: JobDetailPage,
});

const settingsLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
	getParentRoute: () => settingsLayoutRoute,
	path: '/',
	beforeLoad: () => {
		throw redirect({ to: '/settings/aliases' });
	},
});

const settingsAliasesRoute = createRoute({
	getParentRoute: () => settingsLayoutRoute,
	path: 'aliases',
	component: AliasesPage,
});

const settingsTimeoutRoute = createRoute({
	getParentRoute: () => settingsLayoutRoute,
	path: 'timeout',
	component: TimeoutSettingsPage,
});

const routeTree = rootRoute.addChildren([
	consoleLayoutRoute.addChildren([consoleIndexRoute, jobDetailRoute]),
	settingsLayoutRoute.addChildren([
		settingsIndexRoute,
		settingsAliasesRoute,
		settingsTimeoutRoute,
	]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
