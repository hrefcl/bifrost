import axios from 'axios';

/**
 * Cliente HTTP compartido (singleton de módulo).
 *
 * NO se expone a través del store de Pinia: una instancia de axios es CALLABLE, y un setup
 * store de Pinia trata cualquier propiedad-función devuelta como una "action", envolviéndola
 * y descartando sus métodos (`.get`/`.post`/…). Exponerla por módulo evita ese envoltorio.
 * El store de auth importa esta misma instancia para fijar el header Authorization y montar
 * el interceptor de refresh; los componentes/otros stores la consumen directamente.
 */
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});
