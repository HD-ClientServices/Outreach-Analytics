-- Tags de FIN de secuencia como señal de pertenencia.
--
-- Al terminar, el V2 BULK FUP COLD BLAST le saca al contacto `secuencia bfcb`
-- (y la rama) y le pone `ended fcb`. La clasificación lee los tags del contacto
-- en el momento de procesarlo, así que todo contacto procesado —o re-procesado
-- por un refresh posterior— después de terminar la secuencia caía en 'none' y
-- perdía sus eventos. Verificado el 21/10/2026: contactos con `ended fcb` y sin
-- tag de secuencia cuyo último SMS es el "Final note" oficial de la rama B.
--
-- `debtmd sequence finished` es el equivalente de Partner CC.

update sms_analytics.workflows set tags = 'secuencia bfcb,ended fcb'
 where key = 'cold' and tags = 'secuencia bfcb';

update sms_analytics.workflows set tags = 'debtmd sequence,secuencia partner cc,debtmd sequence finished'
 where key = 'cc' and tags = 'debtmd sequence,secuencia partner cc';
