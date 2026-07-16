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
  if (ALLOWED_HOSTS.has(url.hostname)) return next();

  url.protocol = 'https:';
  url.hostname = CANONICAL_HOST;
  url.port = '';
  return Response.redirect(url.toString(), 301);
}
