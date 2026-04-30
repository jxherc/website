export function corsHeaders(request, env) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const allow   = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export function cors(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
