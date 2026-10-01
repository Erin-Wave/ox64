// ox64.pages.dev(기본 서브도메인)와 커밋별 프리뷰 URL(<hash>.ox64.pages.dev)로 들어온 요청을
// ox64.app 으로 301 리다이렉트한다. Cloudflare Pages 는 *.pages.dev 를 끄는 대시보드 옵션이
// 없어서(항상 살아있음) 전역 미들웨어로 막는 게 표준적인 방법.
const CANONICAL_HOST = 'ox64.app';
const ALLOWED_HOSTS = new Set([CANONICAL_HOST, 'localhost', '127.0.0.1']);

export function onRequest({
  request,
  next,
}: {
  request: Request;
  next: () => Promise<Response>;
}): Response | Promise<Response> {
  const url = new URL(request.url);
  if (ALLOWED_HOSTS.has(url.hostname)) {
    // ⚠ 다른 사이트에서 보낸 상태 변경 요청은 막는다(2026-10-01). 세션 쿠키는 SameSite=Lax 라 교차 사이트 POST 에 안 실리지만, **로그인·
    // 로그아웃은 쿠키가 필요 없어서** 악성 페이지의 text/plain 폼(본문이 JSON 으로 읽히게 짠 것)이 방문자를 공격자 계정으로 로그인시킬 수
    // 있었다(감사). 브라우저는 교차 출처 POST 에 Origin 을 항상 붙이므로 그게 이 사이트가 아니면 거절한다(헤더가 없으면 = 같은 출처·도구).
    if (request.method !== 'GET' && request.method !== 'HEAD' && url.pathname.startsWith('/api/')) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
    }
    return next();
  }

  url.protocol = 'https:';
  url.hostname = CANONICAL_HOST;
  url.port = '';
  return Response.redirect(url.toString(), 301);
}
