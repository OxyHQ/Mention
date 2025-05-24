export class ApiError extends Error {
    statusCode: number;
    
    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'ApiError';
    }
}

export const createError = (statusCode: number, message: string) => {
    return new ApiError(statusCode, message);
}; 