function init(hub) {
    async function linkAccount(interaction, code) {
        const discordId = interaction.user.id;
        await interaction.deferReply({ flags: 64 });

        let result;
        try {
            result = await hub.api('POST', '/tradebot/link-verify', { discord_id: discordId, code });
        } catch (err) {
            if (err.status === 400) {
                return interaction.editReply('❌ Invalid or expired code. Run `!link` in Minecraft to get a new one.');
            }
            throw err;
        }

        if (result.updated) {
            await interaction.editReply('✅ Account updated! Your Minecraft and Discord accounts are now re-linked.');
        } else {
            await interaction.editReply('✅ Accounts linked! Your Minecraft and Discord trade history will now be combined.');
        }
    }

    async function unlinkAccount(interaction) {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder()
            .setCustomId('unlink_confirm_modal')
            .setTitle('Unlink Minecraft Account');
        const input = new TextInputBuilder()
            .setCustomId('confirm_text')
            .setLabel('Type UNLINK to confirm')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('UNLINK')
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    async function confirmUnlink(interaction) {
        const discordId = interaction.user.id;
        const value = interaction.fields.getTextInputValue('confirm_text').trim();
        if (value.toUpperCase() !== 'UNLINK') {
            return interaction.reply({ content: '❌ Confirmation text did not match. Type UNLINK exactly.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });
        try {
            await hub.api('DELETE', `/tradebot/link/${discordId}`);
            await interaction.editReply('✅ Your Minecraft account has been unlinked.');
        } catch (err) {
            if (err.status === 404) {
                return interaction.editReply('❌ No linked Minecraft account found.');
            }
            throw err;
        }
    }

    return { linkAccount, unlinkAccount, confirmUnlink };
}

module.exports = init;
