import { getAuthenticatedUser } from "@/lib/api-auth";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getApiDocs } from "@/lib/swagger";

export async function GET(request: NextRequest) {
  if (!await getAuthenticatedUser(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const spec = getApiDocs();
  return NextResponse.json(spec);
}
