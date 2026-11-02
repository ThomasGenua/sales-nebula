const configured = import.meta.env.VITE_PUBLIC_SITE_URL || 'https://salesnebula.com';
export const siteOrigin = new URL(configured).origin;
export const PUBLIC_META = {
  '/': ['Sales Nebula — Keep your next win in sight', 'Bring your pipeline, people, quotes, and customer relationships together. Explore the instant browser demo or discuss a workspace for your team.'],
  '/hosting': ['Hosting options — Sales Nebula', 'Compare self-hosting with hosting by arrangement. Understand deployment, backups, support, provider accounts, and costs before starting.'],
  '/tour': ['Product walkthrough — Sales Nebula', 'See the real Sales Nebula interface with sample records. Follow a lead through an opportunity and quote, then try the interactive tour.'],
  '/privacy': ['Privacy — Sales Nebula', 'How Sales Nebula handles access requests, workspace data, and optional website measurement.'],
  '/terms': ['Terms of service — Sales Nebula', 'Terms for using the Sales Nebula website and CRM workspace.'],
};
export function metadata(path) {
  const [title, description] = PUBLIC_META[path] || ['Your workspace — Sales Nebula', 'Sign in, manage your access request, or explore the sample Sales Nebula workspace.'];
  return { title, description, canonical: `${siteOrigin}${PUBLIC_META[path] ? path : '/'}`, robots: PUBLIC_META[path] ? 'index, follow' : 'noindex, nofollow' };
}
export function applyMetadata(path) {
  const meta = metadata(path);
  document.title = meta.title;
  for (const [attribute, name, value] of [['name', 'description', meta.description], ['name', 'robots', meta.robots], ['property', 'og:title', meta.title], ['property', 'og:description', meta.description], ['property', 'og:url', meta.canonical], ['name', 'twitter:title', meta.title], ['name', 'twitter:description', meta.description]]) {
    const node = document.querySelector(`meta[${attribute}="${name}"]`); if (node) node.content = value;
  }
  const canonical = document.querySelector('link[rel="canonical"]'); if (canonical) canonical.href = meta.canonical;
}
