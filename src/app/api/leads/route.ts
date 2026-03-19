import { NextResponse } from "next/server";
import { LEADS } from "@/data/leads";

export function GET() {
  return NextResponse.json(LEADS);
}
