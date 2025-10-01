import { NextRequest } from "next/server";

// Configuration constants
const API_REQUEST_TIMEOUT_MS = 5000; // 5 seconds timeout

// Helper function to safely log errors without sensitive data
function logSafeError(message: string, error: any) {
  const safeErrorInfo = {
    message: message,
    errorType: error?.constructor?.name || 'Unknown',
    errorCode: error?.code,
    statusCode: error?.status,
    // Only log stack trace in development
    ...(process.env.NODE_ENV === 'development' && { stack: error?.stack })
  };
  
  console.error(safeErrorInfo);
}

// API endpoint to get API key status (which keys are configured)
export async function GET(req: NextRequest) {
  try {
    // Forward the request to the backend agent API
    const BYTEBOT_AGENT_BASE_URL = process.env.BYTEBOT_AGENT_BASE_URL || "http://localhost:3001";
    
    // Set up timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
    
    let response;
    try {
      response = await fetch(`${BYTEBOT_AGENT_BASE_URL}/api-keys/status`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      
      // Clear timeout on successful response
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      
      // Handle timeout specifically
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        logSafeError("API key status request timed out", { 
          timeout: API_REQUEST_TIMEOUT_MS,
          errorName: fetchError.name 
        });
        return new Response(
          JSON.stringify({ 
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
    const contentType = response.headers.get('content-type');
    
    // Read response body as text first to avoid consuming the stream
    const responseText = await response.text().catch(() => "Unable to read response body");
    
    if (contentType && contentType.includes('application/json')) {
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        logSafeError("Failed to parse JSON response from backend", parseError);
        return new Response(
          JSON.stringify({ 
            error: `Invalid JSON response from backend: ${responseText}`,
            status: response.status,
            statusText: response.statusText
          }),
          { 
            status: 502,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    } else {
      // Non-JSON response, return the text content
      return new Response(
        JSON.stringify({ 
          error: `Backend returned non-JSON response: ${responseText}`,
          status: response.status,
          statusText: response.statusText
        }),
        { 
          status: 502,
          headers: { "Content-Type": "application/json" }
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
    logSafeError("Error fetching API key status", error);
    return new Response(
      JSON.stringify({ 
        error: "Failed to fetch API key status" 
      }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}