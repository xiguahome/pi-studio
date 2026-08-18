import { readBuiltinSeedStatus } from "@/lib/builtin-extensions";
import type { BuiltinSeedStatus } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// Lightweight, cwd-independent seed status for the first-run overlay. Unlike
// /api/plugins (which requires a cwd), this is callable before the user has
// picked any project, because seed state is global — a single
// ~/.pi-studio/.builtin-seed.json for the whole agent dir. When the file does not
// exist yet (very first boot, before instrumentation has written it) we return
// a seeding:true stub so the client starts polling instead of assuming done.
export async function GET(): Promise<Response> {
  const status: BuiltinSeedStatus = readBuiltinSeedStatus() ?? {
    seeding: true,
    results: [],
  };
  return Response.json(status);
}
