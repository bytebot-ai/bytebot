import { NextRequest } from "next/server";

const BASE_URL = process.env.BYTEBOT_AGENT_BASE_URL;

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const subPath = path.length > 0 ? `/${path.join('/')}` : '';
  const url = `${BASE_URL}${subPath}${req.nextUrl.search}`;
  const init: RequestInit = {
    method: req.method,
    headers: { "Content-Type": "application/json" },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }
  const res = await fetch(url, init);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handler(req: NextRequest, { params }: { params: { path?: string[] } }) {
  return proxy(req, params.path ?? []);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
