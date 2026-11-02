import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import Root from './Root';
import { ThemeProvider } from './theme';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/800.css';
import './index.css';

const root = document.getElementById('root');
const path = window.location.pathname.replace(/\/$/, '') || '/';
const tree = <React.StrictMode><ThemeProvider><Root initialPath={path} /></ThemeProvider></React.StrictMode>;
if (root.dataset.prerender === path) hydrateRoot(root, tree);
else createRoot(root).render(tree);
