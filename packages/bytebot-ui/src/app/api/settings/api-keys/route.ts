import { NextRequest } from "next/server";

// Configuration constants
const API_REQUEST_TIMEOUT_MS = 8000; // 8 seconds timeout

// API endpoint to save API keys
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    // Forward the request to the backend agent API
    const BYTEBOT_AGENT_BASE_URL = process.env.BYTEBOT_AGENT_BASE_URL || "http://localhost:3001";
    
    // Set up timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
    
    let response;
    try {
      response = await fetch(`${BYTEBOT_AGENT_BASE_URL}/api-keys/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      // Clear timeout on successful response
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      
      // Handle timeout specifically
      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: `Request timed out after ${API_REQUEST_TIMEOUT_MS / 1000} seconds`,
            timeout: true
          }),
          { 
            status: 504, // Gateway Timeout
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      
      // Re-throw other fetch errors to be handled by outer catch
      throw fetchError;
    }
    
    // Handle response parsing safely
    let result;
    let responseContentType = "application/json";
    const originalContentType = response.headers.get('content-type');
    
    try {
      result = await response.json();
    } catch (parseError) {
      console.error("Failed to parse JSON response from backend:", parseError);
      // Fall back to text response
      const text = await response.text().catch(() => "Unable to read response body");
      
      // Use original content-type or default to text/plain
      responseContentType = originalContentType || "text/plain";
      
      return new Response(
        text,
        { 
          status: response.status,
          headers: { "Content-Type": responseContentType }
        }
      );
    }
    
    return new Response(
      JSON.stringify(result),
      { 
        status: response.status,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("Error saving API keys:", error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: "Failed to save API keys" 
      }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}