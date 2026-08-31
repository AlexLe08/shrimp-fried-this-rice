import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
export default {
    data: new SlashCommandBuilder().setName('server').setDescription('Provides information about the server.'),
    async execute(interaction) {
        // interaction.guild is the object representing the Guild in which the command was run
        if (!interaction.inCachedGuild()) {
            await interaction.reply("This command can only be used in a server.");
            return;
        }
        await interaction.reply(`This server is ${interaction.guild.name} and has ${interaction.guild.memberCount} members.`);
    },
};
//# sourceMappingURL=server.js.map