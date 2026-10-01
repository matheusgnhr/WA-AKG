import { NextResponse, NextRequest } from 'next/server';
import { getAuthenticatedUser, canAccessSession } from '@/lib/api-auth';
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: 'Unauthorized' }, { status: 401 });
    const { sessionId } = await params;
    if (!await canAccessSession(user.id, user.role, sessionId)) return NextResponse.json({ status: false, message: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ status: false, message: 'Bulk broadcast is disabled. Use governed individual message dispatch.' }, { status: 410 });
}
