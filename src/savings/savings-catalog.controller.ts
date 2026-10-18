import { Controller, Get } from '@nestjs/common';
import { savingsCatalog } from './catalog';

/**
 * Tasas y topes de ahorro, públicos (sin sesión): los usan el inicio, el Centro
 * de ayuda y Banki para no tener las cifras escritas a mano en el frontend.
 */
@Controller('savings')
export class SavingsCatalogController {
  @Get('catalog')
  catalog() {
    return savingsCatalog();
  }
}
