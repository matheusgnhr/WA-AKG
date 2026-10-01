import { getAuthenticatedUser } from "@/lib/api-auth";
import { getApiDocs } from "@/lib/swagger";
import { NextRequest,NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  if (!await getAuthenticatedUser(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const spec = getApiDocs();
  return NextResponse.json(spec);
}
