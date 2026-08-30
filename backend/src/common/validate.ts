import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';

function respondWithValidationError(res: Response, error: import('zod').ZodError): void {
  const flat = error.flatten();
  const fieldMessages = Object.values(flat.fieldErrors)
    .flat()
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
  const formMessages = flat.formErrors.filter(m => m.length > 0);
  const allMessages = [...fieldMessages, ...formMessages];
  res.status(400).json({
    error: allMessages.length > 0 ? allMessages.join('; ') : 'Validation failed',
    fields: flat.fieldErrors,
  });
}

export function validateBody(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      respondWithValidationError(res, result.error);
      return;
    }
    req.body = result.data;
    next();
  };
}

/** Same contract as {@link validateBody}, applied to `req.query` instead. */
export function validateQuery(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      respondWithValidationError(res, result.error);
      return;
    }
    // Express 4's req.query is a plain writable property (unlike Express 5).
    req.query = result.data as typeof req.query;
    next();
  };
}
