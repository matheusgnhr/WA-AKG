"use client";
import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
export default function ApiDocsPage() {
    return <main><h1>WA-AKG API documentation</h1><SwaggerUI url="/api/docs" /></main>;
}
