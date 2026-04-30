import { handleAuth }      from './routes/auth.js';
import { handlePosts }     from './routes/posts.js';
import { handleStatus }    from './routes/status.js';
import { handleBookmarks } from './routes/bookmarks.js';
import { handlePhotos }    from './routes/photos.js';
import { handleDiscord }   from './routes/discord.js';
import { cors, corsHeaders } from './lib/cors.js';

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return cors(request, env);

    let response;
    if (path === '/auth' || path.startsWith('/auth/'))
      response = await handleAuth(request, env);
    else if (path === '/posts' || path.startsWith('/posts/'))
      response = await handlePosts(request, env, path);
    else if (path === '/status')
      response = await handleStatus(request, env);
    else if (path === '/bookmarks' || path.startsWith('/bookmarks/'))
      response = await handleBookmarks(request, env, path);
    else if (path === '/photos' || path.startsWith('/photos/'))
      response = await handlePhotos(request, env, path);
    else if (path === '/discord' || path.startsWith('/discord/'))
      response = await handleDiscord(request, env);
    else
      response = new Response('not found', { status: 404 });

    const headers = new Headers(response.headers);
    Object.entries(corsHeaders(request, env)).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, { status: response.status, headers });
  }
};
