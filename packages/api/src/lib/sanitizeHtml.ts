import sanitize from 'sanitize-html';

export const defaultOptions: sanitize.IOptions = {
  allowedTags: sanitize.defaults.allowedTags.concat(['img', 'h1', 'h2', 'blockquote']),
  allowedAttributes: {
    ...sanitize.defaults.allowedAttributes,
    img: ['src', 'alt', 'width', 'height'],
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitize.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitize(html, defaultOptions);
}

export function plainTextFromHtml(html: string): string {
  return sanitize(html, { allowedTags: [], allowedAttributes: {} }).trim();
}
