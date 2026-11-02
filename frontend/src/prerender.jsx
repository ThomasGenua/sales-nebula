import React from 'react';
import { renderToString } from 'react-dom/server';
import Root from './Root';
import { ThemeProvider } from './theme';
export { PUBLIC_META, metadata, siteOrigin } from './metadata';
export function render(path) {
  return renderToString(<React.StrictMode><ThemeProvider><Root initialPath={path} /></ThemeProvider></React.StrictMode>);
}
